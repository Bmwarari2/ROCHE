import {
  type WorkflowInstanceItem,
  WorkflowInstanceList,
  WorkflowListView,
} from "@harbour/contracts";
import {
  candourRecord,
  dolsLegalChangeReview,
  exitRecord,
  incident,
  outage,
  statutoryNotification,
  type Transaction,
  workflowInstance,
} from "@harbour/db";
import {
  LISTED_WORKFLOW_PERMISSIONS,
  LISTED_WORKFLOWS,
  listedWorkflow,
  type Permission,
  workflowActorView,
  workflowPermissions,
  workflowSlaState,
} from "@harbour/domain";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, notInArray, or, type SQL, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  permissionsReaching,
  requireAnyPermission,
  usablePermissions,
  withTenant,
} from "../http/context";
import { staffNames } from "../services/staff";
import { errorResponses, jsonBody, security } from "./openapi";

/**
 * Workflow instances across modules, for the approvals screen (PLAT-011; platform.md, task and
 * workflow engine). Read only: every step is still taken on the record's own route, which checks
 * the module's rules (closing an incident checks its notifications and candour record, HZ-013) and
 * separation of duties again. This list says where each open record stands against its deadline
 * and which steps the reader may take, marking the approval step the record's creator may not take.
 *
 * Only the workflows in `LISTED_WORKFLOWS` (packages/domain) are listed; the person lifecycle is a
 * record's status, not work waiting for someone, so it is not among them. An instance about nobody
 * (an incident, an outage) is listed only when the reader can see its record under row-level
 * security; an unknown subject type is never listed (closed by default).
 */

const LIST_PERMISSIONS = LISTED_WORKFLOW_PERMISSIONS as [Permission, ...Permission[]];

/** Most instances one list holds; `truncated` says when more were open. */
const LIMIT = 300;

interface SubjectFacts {
  readonly incidentId: string | null;
  readonly locationId: string | null;
}

/**
 * The subjects of each type the reader can see (row-level security in this transaction), with
 * what their links need. A type missing here is never visible.
 */
async function visibleSubjects(
  tx: Transaction,
  wanted: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, SubjectFacts>> {
  const seen = new Map<string, SubjectFacts>();
  const none: SubjectFacts = { incidentId: null, locationId: null };
  const ids = (type: string) => [...(wanted.get(type) ?? [])];
  const each = async <R extends { id: string }>(
    type: string,
    load: (list: string[]) => Promise<R[]>,
    facts: (row: R) => SubjectFacts = () => none,
  ) => {
    const list = ids(type);
    if (list.length === 0) return;
    for (const row of await load(list)) seen.set(`${type}:${row.id}`, facts(row));
  };
  await each("incident", (list) =>
    tx.select({ id: incident.id }).from(incident).where(inArray(incident.id, list)),
  );
  // A candour record shows only with its incident.
  await each(
    "candour_record",
    (list) =>
      tx
        .select({ id: candourRecord.id, incidentId: candourRecord.incidentId })
        .from(candourRecord)
        .innerJoin(incident, eq(incident.id, candourRecord.incidentId))
        .where(inArray(candourRecord.id, list)),
    (row) => ({ incidentId: row.incidentId, locationId: null }),
  );
  await each("statutory_notification", (list) =>
    tx
      .select({ id: statutoryNotification.id })
      .from(statutoryNotification)
      .where(inArray(statutoryNotification.id, list)),
  );
  await each(
    "outage",
    (list) =>
      tx
        .select({ id: outage.id, locationId: outage.locationId })
        .from(outage)
        .where(inArray(outage.id, list)),
    (row) => ({ incidentId: null, locationId: row.locationId }),
  );
  await each("exit_record", (list) =>
    tx.select({ id: exitRecord.id }).from(exitRecord).where(inArray(exitRecord.id, list)),
  );
  await each("dols_legal_change_review", (list) =>
    tx
      .select({ id: dolsLegalChangeReview.id })
      .from(dolsLegalChangeReview)
      .where(inArray(dolsLegalChangeReview.id, list)),
  );
  return seen;
}

/** Open instances: each listed workflow's, outside its terminal states. */
function openCondition(): SQL {
  const parts = LISTED_WORKFLOWS.map((w) =>
    w.terminal.length > 0
      ? and(
          eq(workflowInstance.definitionKey, w.key),
          notInArray(workflowInstance.state, [...w.terminal]),
        )
      : eq(workflowInstance.definitionKey, w.key),
  );
  return or(...parts) ?? sql`false`;
}

export const workflowsRouter = new OpenAPIHono<AppEnv>().openapi(
  createRoute({
    method: "get",
    path: "/v1/workflows",
    tags: ["platform"],
    summary: "Open workflows in your scope, with their deadline state and the steps open to you",
    description:
      "For the approvals screen (PLAT-011). view=approvals (the default) lists records waiting for your approval and ones you raised that wait for someone else's; view=all lists every open workflow you have a part in. Steps are taken on each record's own route, which checks its rules and separation of duties again. Soonest deadline first.",
    security,
    request: { query: z.object({ view: WorkflowListView.default("approvals") }) },
    responses: {
      200: jsonBody(WorkflowInstanceList, "Workflows"),
      ...errorResponses,
    },
  }),
  async (c) => {
    const access = await requireAnyPermission(c, LIST_PERMISSIONS);
    const { view } = c.req.valid("query");
    const now = new Date();
    const result = await withTenant(c, async (tx) => {
      const rows = await tx
        .select()
        .from(workflowInstance)
        .where(openCondition())
        .orderBy(
          sql`${workflowInstance.slaDueAt} ASC NULLS LAST`,
          asc(workflowInstance.enteredStateAt),
        )
        .limit(LIMIT + 1);
      const truncated = rows.length > LIMIT;
      const open = rows.slice(0, LIMIT);
      const wanted = new Map<string, string[]>();
      for (const row of open) {
        wanted.set(row.subjectType, [...(wanted.get(row.subjectType) ?? []), row.subjectId]);
      }
      const subjects = await visibleSubjects(tx, wanted);
      const staff = await staffNames(
        tx,
        open.map((r) => r.createdBy),
      );
      const general = usablePermissions(access);
      const byPerson = new Map<string, ReadonlySet<Permission>>();
      const items: WorkflowInstanceItem[] = [];
      for (const row of open) {
        const definition = listedWorkflow(row.definitionKey);
        const facts = subjects.get(`${row.subjectType}:${row.subjectId}`);
        if (!definition || !facts) continue;
        let permissions = general;
        if (row.personId) {
          permissions =
            byPerson.get(row.personId) ?? (await permissionsReaching(tx, access, row.personId));
          byPerson.set(row.personId, permissions);
        }
        const stake = [...workflowPermissions(definition)].some((p) => permissions.has(p));
        if (!stake) continue;
        const actor = workflowActorView(
          definition,
          { state: row.state, createdBy: row.createdBy ?? "" },
          access.tenantUserId,
          permissions,
        );
        if (view === "approvals" && !actor.awaitingYourApproval && !actor.raisedByYou) continue;
        items.push({
          id: row.id,
          definitionKey: row.definitionKey,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          personId: row.personId,
          incidentId: facts.incidentId,
          locationId: facts.locationId,
          state: row.state,
          enteredStateAt: row.enteredStateAt.toISOString(),
          slaDueAt: row.slaDueAt?.toISOString() ?? null,
          slaState: workflowSlaState(row.slaDueAt, now),
          createdBy: staff(row.createdBy),
          moves: actor.moves.map((m) => ({ ...m })),
          awaitingYourApproval: actor.awaitingYourApproval,
          raisedByYou: actor.raisedByYou,
        });
      }
      await auditInTx(tx, access, {
        action: "platform.workflow.list",
        requestId: c.get("requestId"),
        scope: { view, count: items.length },
      });
      return { items, truncated };
    });
    return c.json(result, 200);
  },
);

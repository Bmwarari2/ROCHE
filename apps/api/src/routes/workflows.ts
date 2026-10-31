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
  incidentPerson,
  outage,
  statutoryNotification,
  type Transaction,
  workflowInstance,
} from "@harbour/db";
import {
  approvalStates,
  LISTED_WORKFLOW_PERMISSIONS,
  LISTED_WORKFLOWS,
  listedWorkflow,
  type Permission,
  type PermissionScope,
  scopeFor,
  workflowActorView,
  workflowPermissions,
  workflowSlaStateFor,
} from "@harbour/domain";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  inScopeOf,
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
 * Scope (ADR-0071): each listed permission the session may use is judged in its own scope. A
 * record's subject is looked up under each permission's scope, and the record gets only the
 * permissions whose scope sees it; managing an incident (or its candour record) needs the incident
 * seen whole, as `managesIncident` does. So a permission held at another home never shows a record
 * here or offers a step on it. Break-glass never widens the list.
 *
 * Only the workflows in `LISTED_WORKFLOWS` (packages/domain) are listed; the person lifecycle is a
 * record's status, not work waiting for someone, so it is not among them. An unknown subject type
 * is never listed (closed by default); a removed record or instance never is.
 */

const LIST_PERMISSIONS = LISTED_WORKFLOW_PERMISSIONS as [Permission, ...Permission[]];
const MANAGE_INCIDENTS: Permission = "safety.incident.manage";

/** Most records one list holds; `truncated` says when more visible ones were open. */
const LIMIT = 300;
/** Instances read per page while filling the list. */
const PAGE = 200;
/** Instances read at most before the list stops looking (then `truncated`). */
const SCAN_LIMIT = 3000;

interface SubjectFacts {
  readonly incidentId: string | null;
  readonly locationId: string | null;
  /** For an incident or its candour record: every person on the incident is visible. */
  readonly whole: boolean;
}

/**
 * The subjects of each type visible in the transaction's current scope (row-level security), with
 * what their links need. A type missing here is never visible.
 */
async function visibleSubjects(
  tx: Transaction,
  wanted: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, SubjectFacts>> {
  const seen = new Map<string, SubjectFacts>();
  const ids = (type: string) => [...(wanted.get(type) ?? [])];
  const plain = { incidentId: null, locationId: null, whole: true } as const;

  // Incidents, and the incidents of candour records: which are visible, and which whole.
  const candours =
    ids("candour_record").length > 0
      ? await tx
          .select({ id: candourRecord.id, incidentId: candourRecord.incidentId })
          .from(candourRecord)
          .where(
            and(inArray(candourRecord.id, ids("candour_record")), isNull(candourRecord.deletedAt)),
          )
      : [];
  const incidentIds = [...new Set([...ids("incident"), ...candours.map((c) => c.incidentId)])];
  const incidents =
    incidentIds.length > 0
      ? await tx
          .select({ id: incident.id, personIds: incident.personIds })
          .from(incident)
          .where(and(inArray(incident.id, incidentIds), isNull(incident.deletedAt)))
      : [];
  const people =
    incidents.length > 0
      ? await tx
          .select({ incidentId: incidentPerson.incidentId, personId: incidentPerson.personId })
          .from(incidentPerson)
          .where(
            and(
              inArray(
                incidentPerson.incidentId,
                incidents.map((i) => i.id),
              ),
              isNull(incidentPerson.deletedAt),
            ),
          )
      : [];
  const whole = new Map<string, boolean>();
  for (const row of incidents) {
    const visible = new Set(
      people.filter((p) => p.incidentId === row.id && p.personId).map((p) => p.personId),
    );
    whole.set(
      row.id,
      row.personIds.every((id) => visible.has(id)),
    );
  }
  for (const id of ids("incident")) {
    if (whole.has(id)) {
      seen.set(`incident:${id}`, {
        incidentId: null,
        locationId: null,
        whole: whole.get(id) ?? false,
      });
    }
  }
  for (const c of candours) {
    if (whole.has(c.incidentId)) {
      seen.set(`candour_record:${c.id}`, {
        incidentId: c.incidentId,
        locationId: null,
        whole: whole.get(c.incidentId) ?? false,
      });
    }
  }

  if (ids("statutory_notification").length > 0) {
    const rows = await tx
      .select({ id: statutoryNotification.id })
      .from(statutoryNotification)
      .where(
        and(
          inArray(statutoryNotification.id, ids("statutory_notification")),
          isNull(statutoryNotification.deletedAt),
        ),
      );
    for (const row of rows) seen.set(`statutory_notification:${row.id}`, plain);
  }
  if (ids("outage").length > 0) {
    const rows = await tx
      .select({ id: outage.id, locationId: outage.locationId })
      .from(outage)
      .where(and(inArray(outage.id, ids("outage")), isNull(outage.deletedAt)));
    for (const row of rows) {
      seen.set(`outage:${row.id}`, { incidentId: null, locationId: row.locationId, whole: true });
    }
  }
  if (ids("exit_record").length > 0) {
    const rows = await tx
      .select({ id: exitRecord.id })
      .from(exitRecord)
      .where(and(inArray(exitRecord.id, ids("exit_record")), isNull(exitRecord.deletedAt)));
    for (const row of rows) seen.set(`exit_record:${row.id}`, plain);
  }
  if (ids("dols_legal_change_review").length > 0) {
    const rows = await tx
      .select({ id: dolsLegalChangeReview.id })
      .from(dolsLegalChangeReview)
      .where(
        and(
          inArray(dolsLegalChangeReview.id, ids("dols_legal_change_review")),
          isNull(dolsLegalChangeReview.deletedAt),
        ),
      );
    for (const row of rows) seen.set(`dols_legal_change_review:${row.id}`, plain);
  }
  return seen;
}

/** One key per distinct scope, as `permissionsReaching` keys them. */
const scopeKey = (scope: PermissionScope) =>
  [scope.scope, scope.locationIds.join(","), scope.includesAssigned, scope.includesBreakGlass].join(
    ":",
  );

export const workflowsRouter = new OpenAPIHono<AppEnv>().openapi(
  createRoute({
    method: "get",
    path: "/v1/workflows",
    tags: ["platform"],
    summary: "Open workflows in your scope, with their deadline state and the steps open to you",
    description:
      "For the approvals screen (PLAT-011). view=approvals (the default) lists records waiting for your approval and ones you raised that wait for someone else's; view=all lists every open workflow you have a part in. Each listed permission counts only where its own scope sees the record (ADR-0071). Steps are taken on each record's own route, which checks its rules and separation of duties again. Records whose deadline is kept on the record but not yet carried here come first, then soonest deadline first.",
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
    const usable = new Set(usablePermissions(access));
    const held = LISTED_WORKFLOW_PERMISSIONS.filter((p) => usable.has(p));
    // Each permission in its own scope, without break-glass; permissions sharing a scope share a
    // lookup.
    const scopes = new Map<string, { scope: PermissionScope; permissions: Permission[] }>();
    for (const permission of held) {
      const scope = { ...scopeFor(access.effective, permission), includesBreakGlass: false };
      const key = scopeKey(scope);
      const entry = scopes.get(key) ?? { scope, permissions: [] };
      entry.permissions.push(permission);
      scopes.set(key, entry);
    }
    // Only workflows the reader has a part in, in the states this view lists.
    const parts: SQL[] = [];
    for (const w of LISTED_WORKFLOWS) {
      if (![...workflowPermissions(w)].some((p) => usable.has(p))) continue;
      const states =
        view === "approvals"
          ? approvalStates(w)
          : w.states.filter((s: string) => !w.terminal.includes(s));
      if (states.length === 0) continue;
      const part = and(
        eq(workflowInstance.definitionKey, w.key),
        inArray(workflowInstance.state, states),
      );
      if (part) parts.push(part);
    }
    const onRecordKeys = LISTED_WORKFLOWS.filter((w) => w.deadlineOnRecord).map((w) => w.key);

    const result = await withTenant(c, async (tx) => {
      const items: WorkflowInstanceItem[] = [];
      const creators = new Map<string, string | null>();
      let truncated = false;
      if (parts.length > 0) {
        const open = and(or(...parts), isNull(workflowInstance.deletedAt));
        let offset = 0;
        while (true) {
          const rows = await tx
            .select()
            .from(workflowInstance)
            .where(open)
            .orderBy(
              sql`CASE WHEN ${workflowInstance.slaDueAt} IS NULL AND ${inArray(workflowInstance.definitionKey, onRecordKeys.length > 0 ? onRecordKeys : [""])} THEN 0 ELSE 1 END`,
              sql`${workflowInstance.slaDueAt} ASC NULLS LAST`,
              asc(workflowInstance.enteredStateAt),
              asc(workflowInstance.id),
            )
            .limit(PAGE)
            .offset(offset);
          const wanted = new Map<string, string[]>();
          for (const row of rows) {
            wanted.set(row.subjectType, [...(wanted.get(row.subjectType) ?? []), row.subjectId]);
          }
          const seenByScope = new Map<string, Map<string, SubjectFacts>>();
          for (const [key, { scope }] of scopes) {
            seenByScope.set(key, await inScopeOf(tx, scope, () => visibleSubjects(tx, wanted)));
          }
          for (const row of rows) {
            const definition = listedWorkflow(row.definitionKey);
            if (!definition) continue;
            const subject = `${row.subjectType}:${row.subjectId}`;
            const permissions = new Set<Permission>();
            let facts: SubjectFacts | undefined;
            for (const [key, { permissions: inScope }] of scopes) {
              const seen = seenByScope.get(key)?.get(subject);
              if (!seen) continue;
              facts ??= seen;
              for (const p of inScope) {
                // Managing an incident needs it seen whole (`managesIncident`).
                if (p === MANAGE_INCIDENTS && !seen.whole) continue;
                permissions.add(p);
              }
            }
            const own = [...workflowPermissions(definition)].filter((p) => permissions.has(p));
            if (!facts || own.length === 0) continue;
            const actor = workflowActorView(
              definition,
              { state: row.state, createdBy: row.createdBy ?? "" },
              access.tenantUserId,
              new Set(own),
            );
            if (view === "approvals" && !actor.awaitingYourApproval && !actor.raisedByYou) continue;
            if (items.length === LIMIT) {
              truncated = true;
              break;
            }
            creators.set(row.id, row.createdBy);
            items.push({
              id: row.id,
              definitionKey: row.definitionKey,
              subjectType: row.subjectType,
              subjectId: row.subjectId,
              personId: row.personId,
              incidentId: facts.incidentId,
              locationId: facts.locationId,
              state: row.state,
              startedAt: row.createdAt.toISOString(),
              enteredStateAt: row.enteredStateAt.toISOString(),
              slaDueAt: row.slaDueAt?.toISOString() ?? null,
              slaState: workflowSlaStateFor(definition, row.slaDueAt, now),
              createdBy: null,
              permissions: own,
              moves: actor.moves.map((m) => ({ ...m })),
              awaitingYourApproval: actor.awaitingYourApproval,
              raisedByYou: actor.raisedByYou,
            });
          }
          offset += rows.length;
          if (truncated || rows.length < PAGE) break;
          if (offset >= SCAN_LIMIT) {
            truncated = true;
            break;
          }
        }
      }
      const staff = await staffNames(tx, creators.values());
      const named = items.map((item) => ({ ...item, createdBy: staff(creators.get(item.id)) }));
      await auditInTx(tx, access, {
        action: "platform.workflow.list",
        requestId: c.get("requestId"),
        scope: { view, count: named.length },
      });
      return { items: named, truncated };
    });
    return c.json(result, 200);
  },
);

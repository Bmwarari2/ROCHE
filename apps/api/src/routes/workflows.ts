import {
  type WorkflowInstanceItem,
  WorkflowInstanceList,
  WorkflowListView,
} from "@harbour/contracts";
import {
  candourRecord,
  dolsAuthorisation,
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
  incidentCloseProblems,
  LISTED_WORKFLOW_PERMISSIONS,
  LISTED_WORKFLOWS,
  listedWorkflow,
  type Permission,
  type PermissionScope,
  scopeFor,
  scopeReachesLocation,
  widestScope,
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
import { incidentCloseView } from "../services/safety";
import { staffNames } from "../services/staff";
import { errorResponses, jsonBody, security } from "./openapi";

/**
 * Workflow instances across modules, for the approvals screen (PLAT-011; platform.md, task and
 * workflow engine). Read only: every step is still taken on the record's own route, which checks
 * the module's rules (closing an incident checks its notifications and candour record, HZ-013) and
 * separation of duties again. This list says where each open record stands against its deadline
 * and which steps the reader may take, marking the approval step the record's creator may not take.
 *
 * Reach (ADR-0071; #130 review rounds 1 and 2): each listed permission the session may use counts
 * for a record only when its own scope, without break-glass, both shows the record under row-level
 * security and reaches the record's home (`scopeReachesLocation`, as `managesAt` and
 * `app.holds_permission_at` decide). Visibility alone never decides: an incident shows to its
 * raiser anywhere. Managing an incident, or its candour record, also needs the incident seen whole
 * (`managesIncident`).
 *
 * Only the workflows in `LISTED_WORKFLOWS` (packages/domain) are listed; the person lifecycle is a
 * record's status, not work waiting for someone, so it is not among them. An unknown subject type
 * is never listed (closed by default); a removed record or instance never is.
 */

const LIST_PERMISSIONS = LISTED_WORKFLOW_PERMISSIONS as [Permission, ...Permission[]];
const MANAGE_INCIDENTS: Permission = "safety.incident.manage";

/** Most records one list holds; `truncated` says only that more visible ones were open. */
const LIMIT = 300;
/** Instances read per page while filling the list (keyset paging). */
const PAGE = 200;
/** Sorts after any real deadline, for instances with none. */
const NO_DEADLINE = "9999-12-31T00:00:00Z";

interface SubjectFacts {
  /** The record's home: whether a permission reaches it is decided here. */
  readonly home: string;
  readonly incidentId: string | null;
  /** For an outage's link. */
  readonly locationId: string | null;
  /** For an incident or its candour record: every person on the incident is visible. */
  readonly whole: boolean;
  /** For an incident: what the approvals page needs to offer closing it. */
  readonly incident: {
    readonly version: number;
    readonly status: string;
    readonly closeBlocked: boolean;
  } | null;
}

/**
 * The subjects of each type visible in the transaction's current scope (row-level security), with
 * their home and what their links need. A type missing here is never visible.
 */
async function visibleSubjects(
  tx: Transaction,
  wanted: ReadonlyMap<string, readonly string[]>,
): Promise<Map<string, SubjectFacts>> {
  const seen = new Map<string, SubjectFacts>();
  const ids = (type: string) => [...(wanted.get(type) ?? [])];
  const at = (home: string): SubjectFacts => ({
    home,
    incidentId: null,
    locationId: null,
    whole: true,
    incident: null,
  });

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
          .select({
            id: incident.id,
            locationId: incident.locationId,
            personIds: incident.personIds,
            version: incident.version,
            status: incident.status,
            openQuestions: incident.openQuestions,
            classifierResult: incident.classifierResult,
          })
          .from(incident)
          .where(and(inArray(incident.id, incidentIds), isNull(incident.deletedAt)))
      : [];
  const shownIds = incidents.map((i) => i.id);
  const people =
    shownIds.length > 0
      ? await tx
          .select({ incidentId: incidentPerson.incidentId, personId: incidentPerson.personId })
          .from(incidentPerson)
          .where(
            and(inArray(incidentPerson.incidentId, shownIds), isNull(incidentPerson.deletedAt)),
          )
      : [];
  const byIncident = new Map<string, SubjectFacts>();
  for (const row of incidents) {
    // Closing is offered only where the close route would take it: the same reading
    // (`incidentCloseView`, tenant-wide, so notifications and people the reader cannot see count)
    // and the same rules (`incidentCloseProblems`: notifications, questions and the duty of
    // candour, one record covering only the person it names; HZ-013, #120 review round 2).
    const close = await incidentCloseView(tx, row);
    const visible = new Set(
      people.filter((p) => p.incidentId === row.id && p.personId).map((p) => p.personId),
    );
    byIncident.set(row.id, {
      home: row.locationId,
      incidentId: null,
      locationId: null,
      whole: row.personIds.every((id) => visible.has(id)),
      incident: {
        version: row.version,
        status: row.status,
        closeBlocked:
          incidentCloseProblems({ ...close, openQuestions: row.openQuestions }).length > 0,
      },
    });
  }
  for (const id of ids("incident")) {
    const facts = byIncident.get(id);
    if (facts) seen.set(`incident:${id}`, facts);
  }
  for (const c of candours) {
    const facts = byIncident.get(c.incidentId);
    if (facts) {
      seen.set(`candour_record:${c.id}`, { ...facts, incidentId: c.incidentId, incident: null });
    }
  }

  if (ids("statutory_notification").length > 0) {
    const rows = await tx
      .select({ id: statutoryNotification.id, locationId: statutoryNotification.locationId })
      .from(statutoryNotification)
      .where(
        and(
          inArray(statutoryNotification.id, ids("statutory_notification")),
          isNull(statutoryNotification.deletedAt),
        ),
      );
    for (const row of rows) seen.set(`statutory_notification:${row.id}`, at(row.locationId));
  }
  if (ids("outage").length > 0) {
    const rows = await tx
      .select({ id: outage.id, locationId: outage.locationId })
      .from(outage)
      .where(and(inArray(outage.id, ids("outage")), isNull(outage.deletedAt)));
    for (const row of rows) {
      seen.set(`outage:${row.id}`, { ...at(row.locationId), locationId: row.locationId });
    }
  }
  if (ids("exit_record").length > 0) {
    const rows = await tx
      .select({ id: exitRecord.id, locationId: exitRecord.locationId })
      .from(exitRecord)
      .where(and(inArray(exitRecord.id, ids("exit_record")), isNull(exitRecord.deletedAt)));
    for (const row of rows) seen.set(`exit_record:${row.id}`, at(row.locationId));
  }
  if (ids("dols_legal_change_review").length > 0) {
    const rows = await tx
      .select({ id: dolsLegalChangeReview.id, locationId: dolsAuthorisation.locationId })
      .from(dolsLegalChangeReview)
      .innerJoin(
        dolsAuthorisation,
        eq(dolsAuthorisation.id, dolsLegalChangeReview.dolsAuthorisationId),
      )
      .where(
        and(
          inArray(dolsLegalChangeReview.id, ids("dols_legal_change_review")),
          isNull(dolsLegalChangeReview.deletedAt),
        ),
      );
    for (const row of rows) seen.set(`dols_legal_change_review:${row.id}`, at(row.locationId));
  }
  return seen;
}

/** One page of instances, with the sort keys the next page starts after. */
type InstancePage = {
  readonly row: typeof workflowInstance.$inferSelect;
  readonly bucket: number;
  readonly due: string;
}[];

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
      "For the approvals screen (PLAT-011). view=approvals (the default) lists records waiting for your approval and ones you raised that wait for someone else's; view=all lists every open workflow you have a part in. Each listed permission counts only where its own scope shows the record and reaches its home (ADR-0071). Steps are taken on each record's own route, which checks its rules and separation of duties again. Records in a state whose deadline is kept on the record but not yet carried here come first, then soonest deadline first.",
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
    // The instances are read in the union of those scopes (each record is judged per scope after),
    // so one whose permission needs a fresh step-up still shows (#130 review round 2, L4).
    const union = widestScope([...scopes.values()].map((s) => s.scope));
    // Only workflows the reader has a part in, in the states this view lists.
    const parts: SQL[] = [];
    const onRecord: SQL[] = [];
    for (const w of LISTED_WORKFLOWS) {
      if (![...workflowPermissions(w)].some((p) => usable.has(p))) continue;
      const states =
        view === "approvals"
          ? approvalStates(w)
          : w.states.filter((s: string) => !w.terminal.includes(s));
      if (states.length > 0) {
        const part = and(
          eq(workflowInstance.definitionKey, w.key),
          inArray(workflowInstance.state, states),
        );
        if (part) parts.push(part);
      }
      // Only the states that carry a deadline kept on the record (#130 review round 2, M2).
      const deadlineStates = w.deadlineOnRecord?.states ?? [];
      if (deadlineStates.length > 0) {
        const part = and(
          eq(workflowInstance.definitionKey, w.key),
          inArray(workflowInstance.state, [...deadlineStates]),
        );
        if (part) onRecord.push(part);
      }
    }
    const missingDeadline =
      onRecord.length > 0
        ? sql`CASE WHEN ${workflowInstance.slaDueAt} IS NULL AND (${or(...onRecord)}) THEN 0 ELSE 1 END`
        : sql`1`;
    const due = sql`COALESCE(${workflowInstance.slaDueAt}, ${NO_DEADLINE}::timestamptz)`;

    const result = await withTenant(c, async (tx) => {
      const items: WorkflowInstanceItem[] = [];
      const creators = new Map<string, string | null>();
      let truncated = false;
      if (parts.length > 0 && scopes.size > 0) {
        const open = and(or(...parts), isNull(workflowInstance.deletedAt));
        let after: { bucket: number; due: string; id: string } | null = null;
        while (!truncated) {
          const cursor: { bucket: number; due: string; id: string } | null = after;
          const rows: InstancePage = await inScopeOf(tx, union, () =>
            tx
              .select({
                row: workflowInstance,
                bucket: sql<number>`${missingDeadline}`.mapWith(Number),
                due: sql<string>`to_char(${due} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
              })
              .from(workflowInstance)
              .where(
                cursor
                  ? and(
                      open,
                      sql`(${missingDeadline}, ${due}, ${workflowInstance.id}) > (${cursor.bucket}, ${cursor.due}::timestamptz, ${cursor.id}::uuid)`,
                    )
                  : open,
              )
              .orderBy(sql`${missingDeadline}`, sql`${due}`, asc(workflowInstance.id))
              .limit(PAGE),
          );
          const wanted = new Map<string, string[]>();
          for (const { row } of rows) {
            wanted.set(row.subjectType, [...(wanted.get(row.subjectType) ?? []), row.subjectId]);
          }
          const seenByScope = new Map<string, Map<string, SubjectFacts>>();
          for (const [key, { scope }] of scopes) {
            seenByScope.set(key, await inScopeOf(tx, scope, () => visibleSubjects(tx, wanted)));
          }
          for (const { row } of rows) {
            const definition = listedWorkflow(row.definitionKey);
            if (!definition) continue;
            const subject = `${row.subjectType}:${row.subjectId}`;
            const permissions = new Set<Permission>();
            let facts: SubjectFacts | undefined;
            for (const [key, { scope, permissions: inScope }] of scopes) {
              const seen = seenByScope.get(key)?.get(subject);
              // Shown in this scope, and the scope reaches the record's home.
              if (!seen || !scopeReachesLocation(scope, seen.home)) continue;
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
              slaState: workflowSlaStateFor(definition, row.state, row.slaDueAt, now),
              createdBy: null,
              permissions: own,
              incident: own.includes(MANAGE_INCIDENTS) ? facts.incident : null,
              moves: actor.moves.map((m) => ({ ...m })),
              awaitingYourApproval: actor.awaitingYourApproval,
              raisedByYou: actor.raisedByYou,
            });
          }
          const last = rows.at(-1);
          if (!last || rows.length < PAGE) break;
          after = { bucket: last.bucket, due: last.due, id: last.row.id };
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

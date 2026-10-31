import type {
  ClassifierView,
  IncidentDetail,
  IncidentPersonItem,
  IncidentSummary,
  StatutoryNotificationDetail,
  StatutoryNotificationSummary,
} from "@harbour/contracts";
import { incident, incidentPerson, statutoryNotification, type Transaction } from "@harbour/db";
import {
  CLASSIFIER_QUESTIONS,
  type ClassifierQuestionKey,
  can,
  NOTIFICATION_KINDS,
  type NotificationStatus,
  notificationClockState,
  type Permission,
  type StatutoryNotificationKind,
  scopeFor,
  scopeReachesLocation,
} from "@harbour/domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { writeAudit } from "../http/audit";
import { type AppEnv, inScopeOf, type TenantAccess } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { iso } from "./care-shared";

/**
 * Mappers shared by the incident and statutory notification routes (docs/specs/safety.md). An
 * incident that involves people outside the reader's scope is `restricted`: the header and the
 * reader's own people only, never the narrative or the classifier's reasoning (section 2).
 */

type IncidentRow = typeof incident.$inferSelect;
type PersonRow = typeof incidentPerson.$inferSelect;
type NotificationRow = typeof statutoryNotification.$inferSelect;

export function notificationSummary(n: NotificationRow, now: Date): StatutoryNotificationSummary {
  const kind = n.kind as StatutoryNotificationKind;
  const info = NOTIFICATION_KINDS[kind];
  const status = n.status as NotificationStatus;
  return {
    id: n.id,
    kind,
    label: info.label,
    recipient: info.recipient,
    statutory: info.statutory,
    status,
    provisional: n.provisional,
    noLongerIndicated: n.noLongerIndicated,
    noLongerIndicatedReason: n.noLongerIndicatedReason,
    dueAt: n.dueAt.toISOString(),
    clock: notificationClockState(n.dueAt, status, now),
    locationId: n.locationId,
    incidentId: n.incidentId,
    personId: n.personId,
    dolsAuthorisationId: n.dolsAuthorisationId,
    version: n.version,
  };
}

export function notificationDetail(n: NotificationRow, now: Date): StatutoryNotificationDetail {
  return {
    ...notificationSummary(n, now),
    deadlines: n.deadlines as StatutoryNotificationDetail["deadlines"],
    reasons: n.reasons,
    requiredContent: n.requiredContent,
    sources: n.sources as StatutoryNotificationDetail["sources"],
    statement: (n.statement ?? null) as StatutoryNotificationDetail["statement"],
    content: n.content as Record<string, string>,
    notRequiredReason: n.notRequiredReason,
    submittedAt: iso(n.submittedAt),
    submittedBy: n.submittedBy,
    externalReference: n.externalReference,
    evidenceDocumentId: n.evidenceDocumentId,
    classifierVersion: n.classifierVersion,
    retentionClass: n.retentionClass as StatutoryNotificationDetail["retentionClass"],
  };
}

interface StoredResult {
  readonly classifierVersion: string;
  readonly nationSupported: boolean;
  readonly outputs: readonly {
    kind: StatutoryNotificationKind;
    dueAt: string;
    deadlines: ClassifierView["outputs"][number]["deadlines"];
    reasons: string[];
    provisional: boolean;
    requiredContent: string[];
  }[];
  readonly exclusions: readonly { kind: StatutoryNotificationKind; reason: string }[];
  readonly pending: readonly {
    kind: StatutoryNotificationKind;
    waitingFor: ClassifierQuestionKey[];
  }[];
  readonly tasks: readonly { task: string; reason: string; dueAt: string | null; until?: string }[];
  readonly openQuestions: readonly ClassifierQuestionKey[];
  readonly reasoning: readonly string[];
}

export function questionItem(key: ClassifierQuestionKey) {
  const q = CLASSIFIER_QUESTIONS[key];
  return {
    key,
    kind: q.kind,
    text: q.text,
    help: q.help,
    options: q.options.map((o) => ({ value: o.value, label: o.label })),
    sources: q.sources.map((s) => ({ source: s.source, provision: s.provision, url: s.url })),
  };
}

/** The stored classification, with the drafts the reader can see. */
export function classifierView(
  row: IncidentRow,
  notifications: readonly NotificationRow[],
  now: Date,
): ClassifierView | null {
  const stored = row.classifierResult as StoredResult | null;
  if (!stored || !row.classifiedAt) return null;
  return {
    classifierVersion: stored.classifierVersion,
    classifiedAt: row.classifiedAt.toISOString(),
    nationSupported: stored.nationSupported,
    outputs: stored.outputs.map((o) => ({
      kind: o.kind,
      dueAt: o.dueAt,
      deadlines: o.deadlines,
      reasons: o.reasons,
      provisional: o.provisional,
      requiredContent: o.requiredContent,
    })),
    exclusions: stored.exclusions.map((e) => ({ kind: e.kind, reason: e.reason })),
    pending: stored.pending.map((p) => ({ kind: p.kind, waitingFor: p.waitingFor })),
    openQuestions: stored.openQuestions.map(questionItem),
    tasks: stored.tasks.map((t) => ({
      task: t.task,
      reason: t.reason,
      dueAt: t.dueAt,
      until: t.until ?? null,
    })),
    reasoning: [...stored.reasoning],
    notifications: notifications.map((n) => notificationSummary(n, now)),
  };
}

export function personItem(p: PersonRow): IncidentPersonItem {
  return {
    id: p.id,
    kind: p.kind as IncidentPersonItem["kind"],
    role: p.role as IncidentPersonItem["role"],
    personId: p.personId,
    tenantUserId: p.tenantUserId,
    otherName: p.otherName,
    injuryDetails: p.injuryDetails,
    died: p.died,
    learningDisability: p.learningDisability,
    autistic: p.autistic,
    subjectToMentalHealthAct: p.subjectToMentalHealthAct,
    bodyMapMarkIds: p.bodyMapMarkIds,
    infection: (p.infection ?? null) as IncidentPersonItem["infection"],
    version: p.version,
  };
}

/** True when the incident involves people using the service that the reader cannot see. */
export function isRestricted(row: IncidentRow, visible: readonly PersonRow[]): boolean {
  const seen = new Set(visible.flatMap((p) => (p.personId ? [p.personId] : [])));
  return row.personIds.some((id) => !seen.has(id));
}

export function incidentSummary(row: IncidentRow, restricted: boolean): IncidentSummary {
  return {
    id: row.id,
    locationId: row.locationId,
    type: row.type as IncidentSummary["type"],
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    deviceTime: iso(row.deviceTime),
    lateEntry: row.lateEntry,
    clockDrift: row.clockDrift,
    status: row.status as IncidentSummary["status"],
    raisedBy: row.raisedBy,
    restricted,
    severity: (row.severity ?? null) as IncidentSummary["severity"],
    harmGrade: (row.harmGrade ?? null) as IncidentSummary["harmGrade"],
    classifiedAt: iso(row.classifiedAt),
    openQuestionCount: restricted ? 0 : row.openQuestions.length,
    version: row.version,
  };
}

/** The incident as the reader may see it (row-level security decides which rows come back). */
export async function readIncident(
  tx: Transaction,
  incidentId: string,
): Promise<{ row: IncidentRow; people: PersonRow[]; restricted: boolean }> {
  const [row] = await tx
    .select()
    .from(incident)
    .where(and(eq(incident.id, incidentId), isNull(incident.deletedAt)));
  if (!row) throw problems.notFound();
  const people = await tx
    .select()
    .from(incidentPerson)
    .where(and(eq(incidentPerson.incidentId, incidentId), isNull(incidentPerson.deletedAt)))
    .orderBy(asc(incidentPerson.createdAt));
  return { row, people, restricted: isRestricted(row, people) };
}

export async function incidentDetail(
  tx: Transaction,
  incidentId: string,
  now: Date,
): Promise<IncidentDetail> {
  const { row, people, restricted } = await readIncident(tx, incidentId);
  const notifications = restricted
    ? []
    : await tx
        .select()
        .from(statutoryNotification)
        .where(
          and(
            eq(statutoryNotification.incidentId, incidentId),
            isNull(statutoryNotification.deletedAt),
          ),
        )
        .orderBy(asc(statutoryNotification.dueAt));
  const open = <T>(value: T): T | null => (restricted ? null : value);
  return {
    ...incidentSummary(row, restricted),
    description: open(row.description),
    immediateActions: open(row.immediateActions),
    foundAt: open(iso(row.foundAt)),
    emergencyServicesCalled: open(row.emergencyServicesCalled),
    gpContacted: open(row.gpContacted),
    contactNotes: open(row.contactNotes),
    familyInformed:
      restricted || !row.familyInformedWho || !row.familyInformedAt
        ? null
        : { who: row.familyInformedWho, at: row.familyInformedAt.toISOString() },
    closedBy: row.closedBy,
    closedAt: iso(row.closedAt),
    closedReason: open(row.closedReason),
    retentionClass: row.retentionClass as IncidentDetail["retentionClass"],
    people: people.map(personItem),
    classifier: restricted ? null : classifierView(row, notifications, now),
  };
}

/** Summaries for a list, with each incident's restriction worked out from the reader's people. */
export async function incidentSummaries(
  tx: Transaction,
  rows: readonly IncidentRow[],
): Promise<IncidentSummary[]> {
  if (rows.length === 0) return [];
  const people = await tx
    .select()
    .from(incidentPerson)
    .where(
      and(
        inArray(
          incidentPerson.incidentId,
          rows.map((r) => r.id),
        ),
        isNull(incidentPerson.deletedAt),
      ),
    );
  return rows.map((row) =>
    incidentSummary(
      row,
      isRestricted(
        row,
        people.filter((p) => p.incidentId === row.id),
      ),
    ),
  );
}

const MANAGE: Permission = "safety.incident.manage";

/**
 * Whether the reader manages incidents where this one is: they hold `safety.incident.manage` and
 * its scope shows the incident whole, every one of its people (ADR-0071; ADR-0033). Holding it at
 * another home never counts.
 */
export async function managesIncident(
  tx: Transaction,
  access: TenantAccess,
  incidentId: string,
): Promise<boolean> {
  if (!can(access.effective, MANAGE)) return false;
  const scope = scopeFor(access.effective, MANAGE);
  return inScopeOf(tx, scope, async () => {
    try {
      const { row, restricted } = await readIncident(tx, incidentId);
      // By the incident's home, not by whether it shows: it shows to its raiser anywhere (#130
      // review round 2, M1).
      return !restricted && scopeReachesLocation(scope, row.locationId);
    } catch (error) {
      if (error instanceof HttpProblem && error.status === 404) return false;
      throw error;
    }
  });
}

/**
 * Refuses a step on a notification at a home where the reader does not hold the permission
 * (`safety.notification.submit`): row-level security shows a notification about nobody to the
 * incident's raiser anywhere, so visibility alone never decides (#130 review round 2, M1).
 */
export async function requireHeldAtLocation(
  c: Context<AppEnv>,
  access: TenantAccess,
  permission: Permission,
  record: { readonly type: string; readonly id: string; readonly locationId: string },
): Promise<void> {
  if (scopeReachesLocation(scopeFor(access.effective, permission), record.locationId)) return;
  await writeAudit(c.get("services").appPool, access, {
    action: permission,
    outcome: "denied",
    resourceType: record.type,
    resourceId: record.id,
    reason: "not_held_at_location",
    requestId: c.get("requestId"),
  });
  throw problems.forbidden();
}

/**
 * Refuses, audited, a review or close step to someone who does not manage the incident where it is
 * (`managesIncident`): raising it, or managing incidents at another home, is not enough (#130
 * review round 2, M1).
 */
export async function requireManagesIncident(
  c: Context<AppEnv>,
  tx: Transaction,
  access: TenantAccess,
  incidentId: string,
): Promise<void> {
  if (await managesIncident(tx, access, incidentId)) return;
  await writeAudit(c.get("services").appPool, access, {
    action: MANAGE,
    outcome: "denied",
    resourceType: "incident",
    resourceId: incidentId,
    reason: "not_held_at_location",
    requestId: c.get("requestId"),
  });
  throw problems.forbidden();
}

/** Whether the reader manages incidents at a location (a new incident there, ADR-0071). */
export function managesAt(access: TenantAccess, locationId: string): boolean {
  const { scope, locationIds } = scopeFor(access.effective, MANAGE);
  return scope === "tenant" || (scope === "locations" && locationIds.includes(locationId));
}

/** Whether the reader may change the incident (they raised it, or they manage incidents there). */
export async function mayChange(
  tx: Transaction,
  access: TenantAccess,
  row: IncidentRow,
): Promise<boolean> {
  return row.raisedBy === access.tenantUserId || managesIncident(tx, access, row.id);
}

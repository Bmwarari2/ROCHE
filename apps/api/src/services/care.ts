import {
  accessGrant,
  auditEvent,
  location,
  notification,
  person,
  personCareProfile,
  rateTable,
  recordVersion,
  role,
  roleAssignment,
  type Transaction,
  task,
  tenantUser,
} from "@harbour/db";
import {
  CARE_RATE_KEYS,
  type CareRates,
  type CareTaskKind,
  type CareTrigger,
  checkEntryTime,
  checkTaskLink,
  checkTaskTransition,
  type EntryEvidence,
  entryPermissionTime,
  formatUkDateTime,
  hasClockDrift,
  isClosedRecord,
  isMedicinesTask,
  isPermission,
  nextWeightDueOn,
  type Permission,
  placesCover,
  placesHoldingPermission,
  requiresStepUp,
  resolveCareRates,
  type TaskLinkOutcome,
  type TaskLinkReview,
  type TaskStatus,
  ukDayBounds,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { HttpProblem, problems } from "../http/problem";
import { accessRowsOf } from "./access-rows";
import { roleHolders, roleInForce } from "./role-holders";
import { withTenantWideScope } from "./safety";
import { staffViews } from "./staff-views";
import { anyoneMayBeGiven, mayBeAssigned, OVERDUE_FIRST_RESPONDERS } from "./tasks";

/**
 * Shared rules for the point-of-care record (docs/specs/care.md): rate-table figures, the person's
 * context and care profile, entry times (late entries and clock drift, HZ-017 and HZ-010), the
 * follow-ups the validated tools raise (HZ-014) and completing the task an entry answers.
 */

export async function careRates(
  tx: Transaction,
  tenantId: string,
  nation: "england" | "wales" | "scotland" | "northern_ireland",
): Promise<CareRates> {
  const rows = await tx
    .select()
    .from(rateTable)
    .where(inArray(rateTable.key, Object.values(CARE_RATE_KEYS)));
  return resolveCareRates(
    rows.map((r) => ({
      key: r.key,
      value: r.value,
      unit: r.unit,
      nation: r.nation,
      validFrom: r.validFrom,
      validTo: r.validTo,
      tenantId: r.tenantId,
      verificationStatus: r.verificationStatus,
      source: r.source,
    })),
    nation,
    new Date().toISOString().slice(0, 10),
    tenantId,
  );
}

export interface PersonContext {
  readonly id: string;
  readonly locationId: string;
  readonly nation: "england" | "wales" | "scotland" | "northern_ireland";
  readonly status: typeof person.$inferSelect.status;
  /** Discharged, deceased or archived people are read-only except post-event records (rule 12). */
  readonly closed: boolean;
}

/** The person as the caller may see them (row-level security), or not found. */
export async function personContext(tx: Transaction, personId: string): Promise<PersonContext> {
  const [row] = await tx
    .select({
      id: person.id,
      locationId: person.locationId,
      status: person.status,
      nation: location.nation,
    })
    .from(person)
    .innerJoin(location, eq(location.id, person.locationId))
    .where(and(eq(person.id, personId), isNull(person.deletedAt)));
  if (!row) throw problems.notFound();
  return {
    id: row.id,
    locationId: row.locationId,
    nation: row.nation,
    status: row.status,
    closed: isClosedRecord(row.status),
  };
}

export async function careProfile(tx: Transaction, personId: string) {
  const [row] = await tx
    .select()
    .from(personCareProfile)
    .where(eq(personCareProfile.personId, personId));
  return row ?? null;
}

type CareProfileRow = typeof personCareProfile.$inferSelect;

/** The IDDSI levels prescribed at an entry's time, and whether each has changed since (H-166). */
export interface IddsiLevelsAt {
  readonly food: string | null;
  readonly drink: string | null;
  readonly foodChangedSince: boolean;
  readonly drinkChangedSince: boolean;
}

const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The IDDSI food and drink levels in force when the food or drink was given (H-166, HZ-016), from
 * the care profile's history (`record_version`, a copy of the row before each change, valid until
 * the change): the oldest copy still valid after the entry's time, or the profile as it is now when
 * none is. An entry made before the profile existed had no level prescribed in Harbour. Each level
 * says whether it has changed since, so the entry still tells staff the level is different now.
 */
export async function iddsiLevelsAt(
  tx: Transaction,
  profile: CareProfileRow | null,
  at: Date,
): Promise<IddsiLevelsAt> {
  const now = { food: profile?.iddsiFoodLevel ?? null, drink: profile?.iddsiDrinkLevel ?? null };
  if (!profile) return { ...now, foodChangedSince: false, drinkChangedSince: false };
  const [version] = await tx
    .select({ validFrom: recordVersion.validFrom, data: recordVersion.data })
    .from(recordVersion)
    .where(
      and(
        eq(recordVersion.tableName, "person_care_profile"),
        eq(recordVersion.recordId, profile.id),
        gt(recordVersion.validTo, at),
      ),
    )
    .orderBy(asc(recordVersion.validTo))
    .limit(1);
  const firstFrom = version?.validFrom ?? profile.createdAt;
  const then =
    firstFrom.getTime() > at.getTime()
      ? { food: null, drink: null }
      : !version
        ? now
        : {
            food: textOrNull((version.data as Record<string, unknown>).iddsi_food_level),
            drink: textOrNull((version.data as Record<string, unknown>).iddsi_drink_level),
          };
  return {
    ...then,
    foodChangedSince: then.food !== now.food,
    drinkChangedSince: then.drink !== now.drink,
  };
}

export interface EntryTimes {
  readonly occurredAt: Date;
  readonly deviceTime: Date | null;
  readonly lateEntry: boolean;
  readonly clockDrift: boolean;
}

/**
 * Late means written long after the event: measured from the event to when the entry was made on
 * the device (or received, for the web), never to when an offline device happened to sync.
 * Clock drift compares the device clock when it sent the request with the server clock.
 */
export function entryTimes(
  input: { occurredAt: string; deviceTime?: string | undefined },
  sentAtHeader: string | undefined,
  now: Date,
  rates: CareRates,
): EntryTimes {
  const occurredAt = new Date(input.occurredAt);
  const deviceTime = input.deviceTime ? new Date(input.deviceTime) : null;
  const madeAt = deviceTime ?? now;
  const check = checkEntryTime(occurredAt, madeAt, rates);
  if (!check.ok) throw problems.invalid(check.message);
  if (occurredAt.getTime() - now.getTime() > rates.clockDriftMinutes * 60_000) {
    throw problems.invalid(
      "The time of the event is in the future. Check the time and the device clock.",
    );
  }
  const sentAt = sentAtHeader ? new Date(sentAtHeader) : null;
  const clockDrift =
    sentAt && !Number.isNaN(sentAt.getTime())
      ? hasClockDrift(sentAt, now, rates.clockDriftMinutes)
      : false;
  return { occurredAt, deviceTime, lateEntry: check.lateEntry, clockDrift };
}

/** The point-of-care entries that can stand as evidence that a task was done. */
export type EvidenceType =
  | "care_note"
  | "observation"
  | "body_map_mark"
  | "assessment"
  | "activity_record"
  | "visit_log"
  | "care_plan"
  | "risk_assessment"
  | "advance_care_record";

const TASK_TITLES: Record<CareTaskKind, string> = {
  news2_response: "Respond to NEWS2 score",
  food_and_fluid_record: "Keep a food and fluid record",
  dietitian_referral: "Refer to a dietitian",
  nutrition_assessment: "Complete a nutrition assessment",
  comprehensive_falls_assessment: "Complete a comprehensive falls assessment",
  gait_and_balance_assessment: "Check gait and balance",
  falls_review: "Review falls",
  incident_report: "Consider an incident report",
  safeguarding_decision_guide: "Work through the safeguarding decision guide",
};

/** Who may complete each follow-up (besides an assignee). */
const TASK_PERMISSIONS: Record<CareTaskKind, string> = {
  news2_response: "care.assessment.write",
  food_and_fluid_record: "care.note.write",
  dietitian_referral: "care.plan.write",
  nutrition_assessment: "care.assessment.write",
  comprehensive_falls_assessment: "care.assessment.write",
  gait_and_balance_assessment: "care.assessment.write",
  falls_review: "care.plan.write",
  incident_report: "safety.incident.manage",
  safeguarding_decision_guide: "safety.safeguarding.manage",
};

/**
 * The nurse in charge at a location: the clinical leads and team leaders whose roles reach it
 * (`OVERDUE_FIRST_RESPONDERS`, at every home; no rota is checked), else its Registered Manager;
 * only a role in force, held by someone active (`roleHolders`; HZ-008). The one definition used for urgent result alerts
 * (HZ-014, HZ-016), care plan and risk review notices and refused-entry reviews (ADR-0071 review
 * round 2, C2-M1); each then keeps only those who can see what they are told about
 * (`nurseInChargeSeeing`).
 */
export async function nurseInCharge(
  tx: Transaction,
  locationId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const holders = await roleHolders(tx, OVERDUE_FIRST_RESPONDERS, [locationId], now);
  if (holders.length > 0) return holders;
  return roleHolders(tx, ["registered_manager"], [locationId], now);
}

/**
 * The nurse in charge at the location (`nurseInCharge`) who can see what they are told about: about
 * a person, each of `reads` reaches the person under the member's own scope for it (`staffViews`);
 * about no one, `people.person.read` reaches the location. Filtered only by what the recipient can
 * see, never by a permission to act they do not need to be aware, so a team leader is told whether
 * or not the home has a nurse (ADR-0071 review round 2, C2-M1; HZ-014, HZ-073).
 */
export async function nurseInChargeSeeing(
  tx: Transaction,
  target: { readonly locationId: string; readonly personId: string | null },
  now: Date,
  reads: readonly Permission[] = [RECORD_READ_PERMISSION],
): Promise<string[]> {
  const nurses = await nurseInCharge(tx, target.locationId, now);
  if (nurses.length === 0) return [];
  const personId = target.personId;
  if (personId === null) {
    const rows = await accessRowsOf(tx, nurses);
    return nurses.filter((id) => {
      const mine = rows.get(id);
      return (
        mine !== undefined &&
        placesCover(
          placesHoldingPermission(mine.assignments, mine.grants, RECORD_READ_PERMISSION, now),
          target.locationId,
        )
      );
    });
  }
  let seeing = nurses;
  for (const permission of reads) {
    if (seeing.length === 0) break;
    const views = await staffViews(tx, seeing, [personId], now, permission);
    seeing = seeing.filter((id) => views.get(id)?.people.has(personId) === true);
  }
  return seeing;
}

/** Who acts on a care result alert when the fallback is used: holders of the care plan. */
const ALERT_FALLBACK_PERMISSION: Permission = "care.plan.write";
/**
 * The permission a person's record is opened with: an urgent result alert goes only to someone
 * whose roles or grants carrying it reach the person (ADR-0071).
 */
const RECORD_READ_PERMISSION: Permission = "people.person.read";
/** The audit action of an urgent result alert no one could be told about (HZ-014, HZ-016). */
export const CARE_ALERT_UNROUTED_ACTION = "care.alert.unrouted";

/**
 * How an urgent result alert reached someone, kept on the entry as `flags.alertRoute` so the record
 * says what actually happened (#26 review round 3): the nurse in charge at the location, the
 * fallback (no nurse in charge could open the record), or no one.
 */
export type AlertRoute = "nurse_in_charge" | "fallback" | "no_one";

export interface AlertRecipients {
  readonly route: AlertRoute;
  readonly recipients: readonly string[];
}

/**
 * Who an urgent result alert goes to (#26 review rounds 2 and 3; HZ-014, HZ-016), only ever
 * someone who can open the person's record (`staffViews`, the database's own person scope), on the
 * staff and with a role in force: the nurse in charge at the location (the nurse or senior on
 * shift, else its Registered Manager); with no one there, the Registered Managers across the
 * organisation, then other Registered Managers whose scope covers the person, then the holders of
 * `care.plan.write` who can see the person, longest-serving first in each. A manager at another
 * home who cannot open the record is never chosen. No one, when nobody who can see the person
 * could act. The sync tasks keep their own fallback (`fallbackRecipients`), where assigning the
 * task is what lets its taker see it.
 */
export async function urgentAlertRecipients(
  tx: Transaction,
  target: { readonly personId: string; readonly locationId: string },
  now: Date,
): Promise<AlertRecipients> {
  const seeing = await nurseInChargeSeeing(tx, target, now, [RECORD_READ_PERMISSION]);
  if (seeing.length > 0) return { route: "nurse_in_charge", recipients: seeing };
  const recipients = await alertFallback(tx, target.personId, now);
  return recipients.length > 0
    ? { route: "fallback", recipients }
    : { route: "no_one", recipients };
}

/**
 * The fallback for an urgent result alert (#26 review round 3): members on the staff with a role in
 * force who are Registered Managers or may hold the care plan (by a role, or a grant in force),
 * kept only when they can open the person's record, in tiers: organisation-wide Registered
 * Managers, then the other Registered Managers, then whoever holds `care.plan.write` where it
 * reaches the person (a role mixing portal and staff permissions gives none, as at sign-in).
 * Longest-serving first, then by id.
 */
async function alertFallback(tx: Transaction, personId: string, now: Date): Promise<string[]> {
  // A role in force, held by someone active (`roleInForce`; ADR-0071 review round 3).
  const live = roleInForce(now);
  const since = sql`min(${roleAssignment.validFrom})`;
  const candidates = await tx
    .select({
      id: roleAssignment.tenantUserId,
      manager: sql<boolean>`bool_or(${role.key} = 'registered_manager')`,
      organisationManager: sql<boolean>`bool_or(${role.key} = 'registered_manager' AND ${roleAssignment.locationId} IS NULL AND ${roleAssignment.organisationWide})`,
    })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .innerJoin(tenantUser, eq(tenantUser.id, roleAssignment.tenantUserId))
    .where(live)
    .groupBy(roleAssignment.tenantUserId)
    .having(
      sql`bool_or(${role.key} = 'registered_manager' OR ${ALERT_FALLBACK_PERMISSION} = ANY(${role.permissions}))
        OR EXISTS (
          SELECT 1 FROM ${accessGrant}
          WHERE ${accessGrant.tenantUserId} = ${roleAssignment.tenantUserId}
            AND ${accessGrant.deletedAt} IS NULL
            AND ${accessGrant.revokedAt} IS NULL
            AND ${accessGrant.validFrom} <= ${now.toISOString()}::timestamptz
            AND ${accessGrant.validTo} > ${now.toISOString()}::timestamptz
            AND ${ALERT_FALLBACK_PERMISSION} = ANY(${accessGrant.permissions}))`,
    )
    .orderBy(since, roleAssignment.tenantUserId);
  if (candidates.length === 0) return [];
  const views = await staffViews(
    tx,
    candidates.map((c) => c.id),
    [personId],
    now,
    RECORD_READ_PERMISSION,
  );
  // Holders of the care plan count only where that permission reaches the person (ADR-0071).
  const planViews = await staffViews(
    tx,
    candidates.map((c) => c.id),
    [personId],
    now,
    ALERT_FALLBACK_PERMISSION,
  );
  const sees = (id: string) => views.get(id)?.people.has(personId) === true;
  const holds = (id: string) => planViews.get(id)?.people.has(personId) === true;
  const tiers = [
    candidates.filter((c) => c.organisationManager && sees(c.id)),
    candidates.filter((c) => c.manager && sees(c.id)),
    candidates.filter((c) => sees(c.id) && holds(c.id)),
  ];
  return (tiers.find((tier) => tier.length > 0) ?? []).map((c) => c.id);
}

/**
 * Audits an urgent result alert that no one could be told about, as the system (no actor), with
 * the result's opaque ids and a coded reason (the alert's code), never the result or the person's
 * details.
 */
async function recordUnroutedAlert(
  tx: Transaction,
  source: TriggerSource,
  code: string,
): Promise<void> {
  await tx.insert(auditEvent).values({
    tenantId: sql`app.current_tenant_id()`,
    action: CARE_ALERT_UNROUTED_ACTION,
    outcome: "error",
    resourceType: source.sourceType,
    resourceId: source.sourceId,
    reason: code,
    scope: { personId: source.personId, locationId: source.locationId, reasonCode: code },
  });
}

export interface TriggerSource {
  readonly personId: string;
  readonly locationId: string;
  readonly sourceType: "observation" | "body_map_mark" | "assessment";
  readonly sourceId: string;
  /** UK date of the result, from which a weight schedule runs; defaults to today. */
  readonly occurredOn?: string;
  /**
   * Set when the result was entered from a paper downtime form (operations.md rule 12; HZ-017):
   * alerts and tasks say so, with the time written on the paper, so nobody reads an old reading
   * as current.
   */
  readonly paper?: PaperSource | undefined;
}

/** A back-entered result, as alerts and tasks name it. */
export interface PaperSource {
  /** The back-entry label (`paperLabel`). */
  readonly label: string;
  /** The time written on the paper form. */
  readonly paperAt: Date;
}

/** A task's title, saying when it comes from a paper record and the time written on it. */
function fromPaper(title: string, source: TriggerSource): string {
  return source.paper
    ? `${title} (from a paper record written ${formatUkDateTime(source.paper.paperAt)})`
    : title;
}

/** Repeat screenings scheduled from a result (care.md rule 5): generic titles, never the person. */
const RESCREEN_TITLES: Record<string, string> = {
  must: "Repeat the MUST screening",
  waterlow: "Repeat the Waterlow assessment",
  braden: "Repeat the Braden assessment",
  ng249_falls: "Repeat the falls assessment",
  news2: "Repeat observations",
};

/**
 * Schedules a task for a whole UK day, replacing any open task of the same kind for the person:
 * a schedule moves when a newer result changes it, so only one is ever open (hazard HZ-008).
 */
async function scheduleDayTask(
  tx: Transaction,
  source: TriggerSource,
  spec: { kind: string; title: string; requiredPermission: string; dueOn: string },
): Promise<void> {
  await tx
    .update(task)
    .set({ status: "cancelled", statusReason: "Rescheduled from a newer result" })
    .where(
      and(
        eq(task.personId, source.personId),
        eq(task.kind, spec.kind),
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    );
  const day = ukDayBounds(spec.dueOn);
  await tx.insert(task).values({
    kind: spec.kind,
    title: spec.title,
    requiredPermission: spec.requiredPermission,
    personId: source.personId,
    locationId: source.locationId,
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    dueAt: day.startsAt,
    windowStart: day.startsAt,
    windowEnd: day.endsAt,
    priority: "routine",
  });
}

/**
 * Marks the person's open tasks of a kind done, with the entry that answers them as evidence (a
 * new MUST result answers the scheduled MUST rescreen; a weight answers the weight check).
 */
export async function completeOpenTasks(
  tx: Transaction,
  input: {
    personId: string;
    kind: string;
    /** Only the tasks raised for this record (a review of one risk assessment, say). */
    sourceId?: string;
    evidenceType: EvidenceType;
    evidenceId: string;
    actorTenantUserId: string;
    now: Date;
  },
): Promise<number> {
  const done = await tx
    .update(task)
    .set({
      status: "done",
      completedAt: input.now,
      completedBy: input.actorTenantUserId,
      evidenceType: input.evidenceType,
      evidenceId: input.evidenceId,
    })
    .where(
      and(
        eq(task.personId, input.personId),
        eq(task.kind, input.kind),
        input.sourceId ? eq(task.sourceId, input.sourceId) : undefined,
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    )
    .returning({ id: task.id });
  return done.length;
}

/**
 * Turns the follow-ups a result raised into urgent alerts and tasks (hazard HZ-014). Alerts carry
 * generic titles naming only the home (#26 review round 3), so someone told about a home not their
 * own knows where to go; the link opens the person's record, where the result is shown. `alert` is
 * the routing already worked out for the entry (kept on it as `flags.alertRoute`), so the alert
 * goes where the entry says it went.
 */
export async function raiseCareTriggers(
  tx: Transaction,
  source: TriggerSource,
  triggers: readonly CareTrigger[],
  now: Date,
  alert?: AlertRecipients,
): Promise<number> {
  let raised = 0;
  for (const trigger of triggers) {
    if (trigger.kind === "urgent_alert") {
      const { recipients } = alert ?? (await urgentAlertRecipients(tx, source, now));
      const [home] = await tx
        .select({ name: location.name })
        .from(location)
        .where(eq(location.id, source.locationId));
      let written = 0;
      for (const recipient of recipients) {
        // In the organisation's view, so the alert written for someone else can be counted.
        const made = await withTenantWideScope(tx, () =>
          tx
            .insert(notification)
            .values({
              recipientTenantUserId: recipient,
              kind: "care.urgent_result",
              severity: "urgent",
              title: source.paper
                ? `An observation from a paper record${home ? ` at ${home.name}` : ""} needs a response now`
                : home
                  ? `An observation at ${home.name} needs a response now`
                  : "An observation needs a response now",
              // A back-entered reading says it came from paper, and when (HZ-017).
              body: source.paper
                ? `${source.paper.label} Open the person's record to see the result and the response to take.`
                : "Open the person's record to see the result and the response to take.",
              link: `/people/${source.personId}`,
              channels: ["in_app", "push"],
              sourceType: source.sourceType,
              sourceId: source.sourceId,
              personId: source.personId,
              locationId: source.locationId,
              dedupeKey: `care_alert:${source.sourceId}`,
            })
            .onConflictDoNothing()
            .returning({ id: notification.id }),
        );
        written += made.length;
      }
      // Counted only when someone was told (#26 review round 2, C2); with no one to tell, the
      // alert is audited as unrouted so it is never lost silently.
      if (written > 0) raised++;
      if (recipients.length === 0) {
        await recordUnroutedAlert(tx, source, trigger.code ?? "urgent_result");
      }
    } else if (trigger.kind === "task") {
      await tx.insert(task).values({
        kind: `care.${trigger.task}`,
        title: fromPaper(TASK_TITLES[trigger.task], source),
        requiredPermission: TASK_PERMISSIONS[trigger.task],
        personId: source.personId,
        locationId: source.locationId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        dueAt: now,
        windowEnd: trigger.task === "news2_response" ? new Date(now.getTime() + 15 * 60_000) : null,
        priority: trigger.task === "news2_response" ? "urgent" : "routine",
        statusReason: null,
      });
      raised++;
    } else if (trigger.kind === "repeat_observations") {
      const frequency = trigger.frequency;
      const dueAt =
        frequency.kind === "continuous"
          ? now
          : new Date(now.getTime() + frequency.shortestHours * 3_600_000);
      const windowEnd =
        frequency.kind === "continuous"
          ? new Date(now.getTime() + 15 * 60_000)
          : new Date(now.getTime() + frequency.longestHours * 3_600_000);
      await tx.insert(task).values({
        kind: "care.repeat_observations",
        title: fromPaper(
          frequency.kind === "continuous"
            ? "Monitor observations continuously"
            : "Repeat observations",
          source,
        ),
        requiredPermission: "care.note.write",
        personId: source.personId,
        locationId: source.locationId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        dueAt,
        windowEnd,
        priority: frequency.kind === "continuous" ? "urgent" : "routine",
      });
      raised++;
    } else if (trigger.kind === "rescreen") {
      await scheduleDayTask(tx, source, {
        kind: `care.rescreen.${trigger.toolKey}`,
        title: RESCREEN_TITLES[trigger.toolKey] ?? "Repeat the assessment",
        requiredPermission: "care.assessment.write",
        dueOn: trigger.dueOn,
      });
      raised++;
    } else if (trigger.kind === "weight_interval") {
      await scheduleDayTask(tx, source, {
        kind: "care.weight_check",
        title: "Weigh",
        requiredPermission: "care.note.write",
        dueOn: nextWeightDueOn(source.occurredOn ?? ukIsoDate(now), trigger.interval),
      });
      raised++;
    }
  }
  return raised;
}

/** What happened to the task an entry named (care.md rule 13; HZ-004, HZ-006). */
export type TaskOutcome = TaskLinkOutcome;

/** What an entry will do to the task it names, decided before the entry is written. */
export interface PlannedTaskLink {
  readonly taskId: string;
  readonly kind: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly evidenceRequired: boolean;
  /** Evidence already on the task (a cancelled task keeps the first entry that answered it). */
  readonly evidenceId: string | null;
  readonly outcome: TaskLinkOutcome;
  /** Who reviews it: nobody, the nurse in charge, or the nurse in charge now (a medicines conflict). */
  readonly review: TaskLinkReview;
  /**
   * The author is the task's assignee but may no longer complete it (an acting-up grant that has
   * ended): the entry is kept and reviewed, and the refusal is audited (S1 follow-on).
   */
  readonly assigneeRefused: boolean;
}

/**
 * Decides what an entry does to the task it names, before the entry is written, so the entry
 * records the outcome (`checkTaskLink`). The task row is locked until the transaction ends, so two
 * entries for the same round never both complete it: the second waits and is planned against the
 * closed task (HZ-004). An entry is never lost because of its task (HZ-006); only a task for
 * another person is refused (HZ-001).
 */
export async function planTaskLink(
  tx: Transaction,
  input: {
    taskId: string;
    personId: string;
    actorTenantUserId: string;
    actorPermissions: ReadonlySet<string>;
    /** When the care was recorded (bounded by the clock-drift limit; never after the upload). */
    occurredAt: Date;
    /**
     * Whether the session's sign-in is fresh, for a task whose permission needs a fresh sign-in
     * (review round 2): held when the care was recorded counts for it only when fresh. True for a
     * handed-over entry, whose author is not this session.
     */
    stepUpFresh: boolean;
    /** What the entry is (`isEvidenceFor`; #123 clinical review, M3). */
    evidence?: EntryEvidence;
  },
): Promise<PlannedTaskLink> {
  const [row] = await tx
    .select()
    .from(task)
    .where(and(eq(task.id, input.taskId), isNull(task.deletedAt)))
    .for("update");
  if (!row) throw problems.invalid("That task is not for this person.");
  // The permission the task names, held at its location when the care was recorded
  // (`entryPermissionTime`): a grant that ended before the device uploaded still counts, so the
  // round a carer acting up did is not left open, inviting a repeat dose; a revoked grant never
  // counts, so nobody completes a task by backdating past a revocation, and neither does a grant
  // that ended before the task existed (HZ-004, HZ-006; H-138). Holding it now also counts, and an
  // owner's investigation action is completed by its owner (S1 follow-on; HZ-005).
  const at = entryPermissionTime(input.occurredAt, row.createdAt, new Date());
  const stepUpMet =
    !isPermission(row.requiredPermission) ||
    !requiresStepUp(row.requiredPermission) ||
    input.stepUpFresh;
  const heldWhenRecorded = stepUpMet && (await mayBeAssigned(tx, input.actorTenantUserId, row, at));
  const holdsNow =
    isPermission(row.requiredPermission) && input.actorPermissions.has(row.requiredPermission);
  const asOwner = row.assigneeTenantUserId === input.actorTenantUserId && anyoneMayBeGiven(row);
  const mayComplete = heldWhenRecorded || holdsNow || asOwner;
  const assigneeRefused =
    !mayComplete &&
    row.assigneeTenantUserId === input.actorTenantUserId &&
    (row.status === "open" || row.status === "in_progress");
  const check = checkTaskLink(
    {
      personId: row.personId,
      kind: row.kind,
      status: row.status as TaskStatus,
      evidenceId: row.evidenceId,
      evidenceRequired: row.evidenceRequired,
    },
    {
      personId: input.personId,
      mayComplete,
      ...(input.evidence ? { evidence: input.evidence } : {}),
    },
  );
  if (!check.ok) {
    throw new HttpProblem(422, `task_${check.problem}`, "The entry was not saved.", check.message);
  }
  return {
    taskId: row.id,
    kind: row.kind,
    status: row.status as TaskStatus,
    version: row.version,
    evidenceRequired: row.evidenceRequired,
    evidenceId: row.evidenceId,
    outcome: check.outcome,
    review: check.review,
    assigneeRefused,
  };
}

/** The task kind of the review of an entry that did not complete the task it named. */
export const ENTRY_REVIEW_TASK_KIND = "care.entry_review";
/** The urgent review of a medicines entry that could not complete its task (a dose may be doubled). */
export const ENTRY_CONFLICT_REVIEW_TASK_KIND = "care.entry_conflict_review";
/**
 * At most this many items are listed in one review task's details; the rest are counted. Missed
 * medicines rounds are the exception: they are never dropped (`listMissedRounds`).
 */
export const MAX_TASK_DETAIL_ITEMS = 50;

/**
 * Appends items to a list in a task's details (opaque references only, never clinical text). The
 * list holds at most `MAX_TASK_DETAIL_ITEMS`; items beyond it are counted in `<list>Omitted`, so
 * the review still says that more happened.
 */
export async function appendTaskDetail(
  tx: Transaction,
  taskId: string,
  list: "entries",
  items: readonly Record<string, string | boolean | null>[],
): Promise<void> {
  const [row] = await tx
    .select({ details: task.details })
    .from(task)
    .where(eq(task.id, taskId))
    .for("update");
  if (!row) return;
  const details = { ...((row.details ?? {}) as Record<string, unknown>) };
  const current = Array.isArray(details[list]) ? (details[list] as unknown[]) : [];
  const room = Math.max(0, MAX_TASK_DETAIL_ITEMS - current.length);
  details[list] = [...current, ...items.slice(0, room)];
  const omitted = items.length - Math.min(room, items.length);
  if (omitted > 0) {
    const key = `${list}Omitted`;
    details[key] = (typeof details[key] === "number" ? (details[key] as number) : 0) + omitted;
  }
  await tx.update(task).set({ details }).where(eq(task.id, taskId));
}

/**
 * Carries out a planned link once the entry is written: completes the task with the entry as
 * evidence; keeps it on a cancelled task as late evidence, flagged (the task stays cancelled); or,
 * for a task already closed, already answered, or one the user may not complete, leaves the task
 * alone and gives the nurse in charge one review task listing the entry; for a medicines task that
 * review is a separate, urgent conflict review (HZ-004, HZ-006). An update that finds the task
 * changed after all (it is locked, so it should not) still raises the review, never silently.
 */
export async function applyTaskLink(
  tx: Transaction,
  link: PlannedTaskLink,
  entry: {
    evidenceType: EvidenceType;
    evidenceId: string;
    personId: string;
    locationId: string;
    actorTenantUserId: string;
    deviceId: string | null;
    now: Date;
  },
): Promise<void> {
  let review = link.review;
  let applied = true;
  if (link.outcome === "completed") {
    const check = checkTaskTransition(link.status, {
      to: "done",
      evidenceId: entry.evidenceId,
      evidenceRequired: link.evidenceRequired,
    });
    const updated = check.ok
      ? await tx
          .update(task)
          .set({
            status: "done",
            completedAt: entry.now,
            completedBy: entry.actorTenantUserId,
            evidenceType: entry.evidenceType,
            evidenceId: entry.evidenceId,
          })
          .where(and(eq(task.id, link.taskId), eq(task.version, link.version)))
          .returning({ id: task.id })
      : [];
    if (updated.length > 0) return;
    applied = false;
    review = isMedicinesTask(link.kind) ? "urgent" : "review";
  } else if (link.outcome === "task_cancelled") {
    const updated = await tx
      .update(task)
      .set({
        evidenceType: entry.evidenceType,
        evidenceId: entry.evidenceId,
        evidenceAfterClose: true,
      })
      .where(and(eq(task.id, link.taskId), isNull(task.evidenceId)))
      .returning({ id: task.id });
    if (updated.length > 0) return;
    applied = false;
    review = isMedicinesTask(link.kind) ? "urgent" : "review";
  }
  if (review === "none") return;
  const urgent = review === "urgent";
  const kind = urgent ? ENTRY_CONFLICT_REVIEW_TASK_KIND : ENTRY_REVIEW_TASK_KIND;
  const [open] = await tx
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.personId, entry.personId),
        eq(task.kind, kind),
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  const reviewId =
    open?.id ??
    (
      await tx
        .insert(task)
        .values({
          kind,
          title: urgent
            ? "Check a medicines entry now: it did not complete the medicines task it named"
            : "Review an entry that did not complete the task it named",
          requiredPermission: "care.plan.write",
          personId: entry.personId,
          locationId: entry.locationId,
          sourceType: "task",
          sourceId: link.taskId,
          assigneeRoleKey: "clinical_lead",
          dueAt: entry.now,
          priority: "urgent",
        })
        .returning({ id: task.id })
    )[0]?.id;
  if (!reviewId) return;
  await appendTaskDetail(tx, reviewId, "entries", [
    {
      kind: entry.evidenceType,
      entryId: entry.evidenceId,
      taskId: link.taskId,
      taskKind: link.kind,
      outcome: applied ? link.outcome : "task_changed",
      recordedBy: entry.actorTenantUserId,
      deviceId: entry.deviceId,
      at: entry.now.toISOString(),
    },
  ]);
}

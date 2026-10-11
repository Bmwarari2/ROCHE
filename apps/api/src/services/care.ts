import {
  location,
  notification,
  person,
  personCareProfile,
  rateTable,
  role,
  roleAssignment,
  type Transaction,
  task,
} from "@harbour/db";
import {
  CARE_RATE_KEYS,
  type CareRates,
  type CareTaskKind,
  type CareTrigger,
  checkEntryTime,
  checkTaskTransition,
  hasClockDrift,
  isClosedRecord,
  isPermission,
  nextWeightDueOn,
  resolveCareRates,
  type TaskStatus,
  ukDayBounds,
  ukIsoDate,
} from "@harbour/domain";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { problems } from "../http/problem";
import { OVERDUE_FIRST_RESPONDERS } from "./tasks";

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

/** The nurse or senior on shift at a location; the Registered Manager when nobody holds those roles. */
export async function nurseInCharge(tx: Transaction, locationId: string): Promise<string[]> {
  const holders = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        inArray(role.key, [...OVERDUE_FIRST_RESPONDERS]),
        isNull(roleAssignment.deletedAt),
        or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId)),
      ),
    );
  if (holders.length > 0) return holders.map((h) => h.id);
  const managers = await tx
    .selectDistinct({ id: roleAssignment.tenantUserId })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .where(
      and(
        eq(role.key, "registered_manager"),
        isNull(roleAssignment.deletedAt),
        or(isNull(roleAssignment.locationId), eq(roleAssignment.locationId, locationId)),
      ),
    );
  return managers.map((m) => m.id);
}

export interface TriggerSource {
  readonly personId: string;
  readonly locationId: string;
  readonly sourceType: "observation" | "body_map_mark" | "assessment";
  readonly sourceId: string;
  /** UK date of the result, from which a weight schedule runs; defaults to today. */
  readonly occurredOn?: string;
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
 * generic titles; the link opens the person's record, where the result is shown.
 */
export async function raiseCareTriggers(
  tx: Transaction,
  source: TriggerSource,
  triggers: readonly CareTrigger[],
  now: Date,
): Promise<number> {
  let raised = 0;
  for (const trigger of triggers) {
    if (trigger.kind === "urgent_alert") {
      for (const recipient of await nurseInCharge(tx, source.locationId)) {
        await tx
          .insert(notification)
          .values({
            recipientTenantUserId: recipient,
            kind: "care.urgent_result",
            severity: "urgent",
            title: "An observation needs a response now",
            body: "Open the person's record to see the result and the response to take.",
            link: `/people/${source.personId}`,
            channels: ["in_app", "push"],
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            dedupeKey: `care_alert:${source.sourceId}`,
          })
          .onConflictDoNothing();
      }
      raised++;
    } else if (trigger.kind === "task") {
      await tx.insert(task).values({
        kind: `care.${trigger.task}`,
        title: TASK_TITLES[trigger.task],
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
        title:
          frequency.kind === "continuous"
            ? "Monitor observations continuously"
            : "Repeat observations",
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

/** What happened to the task an entry named (care.md rule 7; HZ-006). */
export type TaskOutcome = "completed" | "task_cancelled" | "task_already_closed" | "not_linked";

/**
 * Completes the task an entry answers, with the entry as evidence. The entry is never refused
 * because of the task (HZ-006): an entry recorded offline before the task was cancelled (the
 * person went to hospital, say) is linked to it and flagged, and the task stays cancelled; a task
 * already done or skipped is left alone; a task the user may not complete is not linked. A task
 * for another person is still refused: that is a wrong-person entry (HZ-001).
 */
export async function completeTaskWithEvidence(
  tx: Transaction,
  input: {
    taskId: string;
    personId: string;
    actorTenantUserId: string;
    actorPermissions: ReadonlySet<string>;
    evidenceType: EvidenceType;
    evidenceId: string;
    now: Date;
  },
): Promise<TaskOutcome> {
  const [row] = await tx
    .select()
    .from(task)
    .where(and(eq(task.id, input.taskId), isNull(task.deletedAt)));
  if (!row || row.personId !== input.personId)
    throw problems.invalid("That task is not for this person.");
  const allowed =
    row.assigneeTenantUserId === input.actorTenantUserId ||
    (isPermission(row.requiredPermission) && input.actorPermissions.has(row.requiredPermission));
  if (!allowed) return "not_linked";
  if (row.status === "cancelled") {
    if (row.evidenceId === null) {
      await tx
        .update(task)
        .set({
          evidenceType: input.evidenceType,
          evidenceId: input.evidenceId,
          evidenceAfterClose: true,
        })
        .where(and(eq(task.id, row.id), eq(task.version, row.version)));
    }
    return "task_cancelled";
  }
  const check = checkTaskTransition(row.status as TaskStatus, {
    to: "done",
    evidenceId: input.evidenceId,
    evidenceRequired: row.evidenceRequired,
  });
  if (!check.ok) return "task_already_closed";
  await tx
    .update(task)
    .set({
      status: "done",
      completedAt: input.now,
      completedBy: input.actorTenantUserId,
      evidenceType: input.evidenceType,
      evidenceId: input.evidenceId,
    })
    .where(and(eq(task.id, row.id), eq(task.version, row.version)));
  return "completed";
}

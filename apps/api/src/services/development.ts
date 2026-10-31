import type { DevelopmentRecord } from "@harbour/contracts";
import {
  competenceSignOff,
  competenceWithdrawal,
  location,
  revalidationEvidence,
  role,
  roleAssignment,
  staffProfile,
  supervisionRecord,
  type Transaction,
  task,
  trainingRecord,
  trainingRequirement,
} from "@harbour/db";
import {
  COMPETENCES,
  type Competence,
  competenceDecision,
  expiryState,
  nextMeeting,
  reminderDays,
  revalidationPlan,
  type StoredSignOff,
  type TrainingRequirement,
  type TrainingTopic,
  trainingMatrix,
  ukEndOfDay,
  ukIsoDate,
  type WorkforceRates,
} from "@harbour/domain";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { NO_STAFF, type StaffLookup, staffNames } from "./staff";
import { workforceRates } from "./staff-files";
import { withSystemRights } from "./system-rights";

/**
 * Training, competence, supervision and revalidation for one member (workforce.md sections 2b and
 * 5; WORK-005, WORK-008, WORK-009, WORK-012): the development record the API shows, built with the
 * slice 4 rules, and the training and competence expiry reminders raised through the task engine.
 */

export const TRAINING_EXPIRY_TASK = "workforce.training_expiry";
export const COMPETENCE_EXPIRY_TASK = "workforce.competence_expiry";
export const DEVELOPMENT_REMINDER_PERMISSION = "workforce.training.manage";
/** Who the reminders go to: the built-in HR role (no person scope: the tasks are about no person). */
export const DEVELOPMENT_REMINDER_ROLE = "hr";

type Nation = "england" | "wales" | "scotland" | "northern_ireland";

/**
 * The member's roles in force (keys, and the built-in key a tenant role is based on) and the
 * nation of the first place they work, read with the system's rights: a training lead with no
 * person scope reads which roles the member holds, nothing else of their access.
 */
async function memberRoles(
  tx: Transaction,
  memberId: string,
  now: Date,
): Promise<{ keys: Set<string>; nation: Nation }> {
  return withSystemRights(tx, async () => {
    const rows = await tx
      .select({ key: role.key, basedOn: role.basedOnKey, nation: location.nation })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .leftJoin(location, eq(location.id, roleAssignment.locationId))
      .where(
        and(
          eq(roleAssignment.tenantUserId, memberId),
          isNull(roleAssignment.deletedAt),
          isNull(role.archivedAt),
          lte(roleAssignment.validFrom, now),
          or(isNull(roleAssignment.validTo), sql`${roleAssignment.validTo} > ${now}`),
        ),
      );
    const keys = new Set<string>();
    for (const r of rows) {
      keys.add(r.key);
      if (r.basedOn) keys.add(r.basedOn);
    }
    const nation = (rows.find((r) => r.nation)?.nation as Nation | undefined) ?? "england";
    return { keys, nation };
  });
}

/** The member's start date, for the first supervision and appraisal (system rights: one date). */
function memberStartedOn(tx: Transaction, memberId: string): Promise<string | null> {
  return withSystemRights(tx, async () => {
    const [row] = await tx
      .select({ startsOn: staffProfile.startsOn })
      .from(staffProfile)
      .where(and(eq(staffProfile.tenantUserId, memberId), isNull(staffProfile.deletedAt)));
    return row?.startsOn ?? null;
  });
}

/** The organisation's requirements for a set of role keys, merged per topic (highest tier, shortest refresh). */
export async function requirementsFor(
  tx: Transaction,
  roleKeys: ReadonlySet<string>,
): Promise<TrainingRequirement[]> {
  if (roleKeys.size === 0) return [];
  const rows = await withSystemRights(tx, () =>
    tx
      .select()
      .from(trainingRequirement)
      .where(
        and(
          eq(trainingRequirement.active, true),
          inArray(trainingRequirement.roleKey, [...roleKeys]),
          isNull(trainingRequirement.deletedAt),
        ),
      ),
  );
  const byTopic = new Map<string, TrainingRequirement>();
  for (const r of rows) {
    const current = byTopic.get(r.topic);
    const refresh =
      current?.refreshYears != null && r.refreshYears != null
        ? Math.min(current.refreshYears, r.refreshYears)
        : (current?.refreshYears ?? r.refreshYears);
    const tier = Math.max(current?.tier ?? 0, r.tier ?? 0);
    byTopic.set(r.topic, {
      topic: r.topic as TrainingTopic,
      refreshYears: refresh ?? null,
      ...(tier > 0 ? { tier: tier as 1 | 2 } : {}),
    });
  }
  return [...byTopic.values()];
}

const trainingRates = (rates: WorkforceRates) => ({
  trainingDefaultRefreshYears: rates.trainingDefaultRefreshYears,
  oliverMcGowanRefreshYears: rates.oliverMcGowanRefreshYears,
  reminderDaysFirst: rates.reminderDaysFirst,
});

/** One member's development record, as the caller's row-level security lets them read it. */
export async function developmentRecord(
  tx: Transaction,
  tenantId: string,
  memberId: string,
  now: Date,
): Promise<DevelopmentRecord | null> {
  const today = ukIsoDate(now);
  const { keys, nation } = await memberRoles(tx, memberId, now);
  const rates = await workforceRates(tx, tenantId, nation, today);
  const records = await tx
    .select()
    .from(trainingRecord)
    .where(and(eq(trainingRecord.workerId, memberId), isNull(trainingRecord.deletedAt)))
    .orderBy(desc(trainingRecord.completedOn));
  const signOffs = await tx
    .select({ s: competenceSignOff, w: competenceWithdrawal })
    .from(competenceSignOff)
    .leftJoin(competenceWithdrawal, eq(competenceWithdrawal.signOffId, competenceSignOff.id))
    .where(eq(competenceSignOff.workerId, memberId))
    .orderBy(desc(competenceSignOff.observedOn));
  const supervisions = await tx
    .select()
    .from(supervisionRecord)
    .where(and(eq(supervisionRecord.workerId, memberId), isNull(supervisionRecord.deletedAt)))
    .orderBy(desc(supervisionRecord.heldOn));
  const [evidence] = await tx
    .select()
    .from(revalidationEvidence)
    .where(and(eq(revalidationEvidence.workerId, memberId), isNull(revalidationEvidence.deletedAt)))
    .orderBy(desc(revalidationEvidence.cycleDueOn))
    .limit(1);
  // Nothing readable about this member: not found for this caller.
  const member = (await staffNames(tx, [memberId]))(memberId);
  if (!member) return null;
  const names: StaffLookup = await staffNames(tx, [
    ...signOffs.flatMap((r) => [r.s.observerId, r.w?.withdrawnBy]),
    ...supervisions.map((s) => s.heldBy),
  ]).catch(() => NO_STAFF);

  const requirements = await requirementsFor(tx, keys);
  const matrix = trainingMatrix(
    requirements,
    records.map((r) => ({
      topic: r.topic as TrainingTopic,
      completedOn: r.completedOn,
      expiresOn: r.expiresOn,
      ...(r.tier ? { tier: r.tier as 1 | 2 } : {}),
    })),
    today,
    trainingRates(rates),
  ).map((m) => ({
    topic: m.topic,
    tier: (requirements.find((r) => r.topic === m.topic)?.tier ?? null) as 1 | 2 | null,
    status: m.status,
    validUntil: m.validUntil,
  }));

  const stored = (competence: Competence): StoredSignOff[] =>
    signOffs
      .filter((r) => r.s.competence === competence)
      .map((r) => ({
        observedOn: r.s.observedOn,
        validUntil: r.s.validUntil,
        withdrawnOn: r.w ? ukIsoDate(r.w.createdAt) : null,
      }));
  const competences = COMPETENCES.filter((c) => signOffs.some((r) => r.s.competence === c)).map(
    (competence) => {
      const decision = competenceDecision(stored(competence), today);
      return {
        competence,
        allowed: decision.allowed,
        reason: decision.allowed ? null : decision.reason,
        validUntil: decision.validUntil,
      };
    },
  );

  const startedOn = await memberStartedOn(tx, memberId);
  const held = supervisions.map((s) => ({
    kind: s.kind as "supervision" | "appraisal" | "spot_check",
    heldOn: s.heldOn,
  }));
  const next = (kind: "supervision" | "appraisal", perYear: number) =>
    startedOn ? nextMeeting(kind, held, startedOn, perYear, today) : null;

  const plan = evidence
    ? revalidationPlan(
        evidence.cycleDueOn,
        {
          practiceHours: evidence.practiceHours,
          cpdHours: evidence.cpdHours,
          participatoryCpdHours: evidence.participatoryCpdHours,
          feedbackPieces: evidence.feedbackPieces,
          reflectiveAccounts: evidence.reflectiveAccounts,
          reflectiveDiscussion: evidence.reflectiveDiscussion,
          healthAndCharacterDeclaration: evidence.healthAndCharacter,
          professionalIndemnity: evidence.professionalIndemnity,
          confirmation: evidence.confirmation,
        },
        today,
        rates,
      )
    : null;

  return {
    member,
    asOf: today,
    matrix,
    trainingRecords: records.map((r) => ({
      id: r.id,
      version: r.version,
      topic: r.topic as TrainingTopic,
      tier: (r.tier ?? null) as 1 | 2 | null,
      completedOn: r.completedOn,
      expiresOn: r.expiresOn,
      provider: r.provider,
    })),
    competences,
    signOffs: signOffs.map((r) => ({
      id: r.s.id,
      competence: r.s.competence as Competence,
      observedOn: r.s.observedOn,
      observer: names(r.s.observerId),
      validUntil: r.s.validUntil,
      withdrawn: r.w
        ? { on: ukIsoDate(r.w.createdAt), by: names(r.w.withdrawnBy), reason: r.w.reason }
        : null,
    })),
    supervisions: supervisions.map((s) => ({
      id: s.id,
      kind: s.kind as "supervision" | "appraisal" | "spot_check",
      heldOn: s.heldOn,
      heldBy: names(s.heldBy),
    })),
    nextSupervision: next("supervision", rates.supervisionsPerYear),
    nextAppraisal: next("appraisal", rates.appraisalsPerYear),
    revalidation:
      evidence && plan
        ? {
            id: evidence.id,
            version: evidence.version,
            cycleDueOn: evidence.cycleDueOn,
            practiceHours: evidence.practiceHours,
            cpdHours: evidence.cpdHours,
            participatoryCpdHours: evidence.participatoryCpdHours,
            feedbackPieces: evidence.feedbackPieces,
            reflectiveAccounts: evidence.reflectiveAccounts,
            reflectiveDiscussion: evidence.reflectiveDiscussion,
            healthAndCharacter: evidence.healthAndCharacter,
            professionalIndemnity: evidence.professionalIndemnity,
            confirmation: evidence.confirmation,
            daysLeft: plan.daysLeft,
            outstanding: [...plan.outstanding],
            ready: plan.ready,
          }
        : null,
  };
}

/**
 * Training and competence expiry reminders (workforce.md section 5): for each member, at each
 * document-expiry offset before a required topic's or a competence's valid-until date, one task
 * for HR, once each (a task already raised for the member, the topic or competence, the date and
 * the offset, whatever its status, stops a second). Runs as the system in each organisation.
 */
export async function raiseDevelopmentReminders(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  const members = new Set<string>([
    ...(await tx.select({ id: trainingRecord.workerId }).from(trainingRecord)).map((r) => r.id),
    ...(await tx.select({ id: competenceSignOff.workerId }).from(competenceSignOff)).map(
      (r) => r.id,
    ),
  ]);
  if (members.size === 0) return 0;
  const sent = await tx
    .select({ sourceId: task.sourceId, kind: task.kind, details: task.details })
    .from(task)
    .where(inArray(task.kind, [TRAINING_EXPIRY_TASK, COMPETENCE_EXPIRY_TASK]));
  const already = (kind: string, memberId: string, subject: string, dueOn: string) =>
    sent
      .filter((s) => s.kind === kind && s.sourceId === memberId)
      .map((s) => s.details as Record<string, unknown> | null)
      .filter(
        (d) =>
          d?.reminderDueOn === dueOn &&
          (d?.trainingTopic === subject || d?.competence === subject) &&
          typeof d?.reminderDays === "number",
      )
      .map((d) => d?.reminderDays as number);
  let raised = 0;
  const raise = async (
    kind: string,
    memberId: string,
    subject: { trainingTopic: string } | { competence: string },
    dueOn: string,
    rates: WorkforceRates,
  ) => {
    const key = "trainingTopic" in subject ? subject.trainingTopic : subject.competence;
    const state = expiryState(
      dueOn,
      today,
      reminderDays(rates),
      already(kind, memberId, key, dueOn),
    );
    if (state.reminderDue === null) return;
    const nearest = Math.min(...reminderDays(rates));
    await tx.insert(task).values({
      kind,
      title:
        kind === TRAINING_EXPIRY_TASK
          ? "Renew training before it expires"
          : "Observe a competence again before it expires",
      requiredPermission: DEVELOPMENT_REMINDER_PERMISSION,
      sourceType: "tenant_user",
      sourceId: memberId,
      locationId: null,
      assigneeRoleKey: DEVELOPMENT_REMINDER_ROLE,
      dueAt: ukEndOfDay(dueOn),
      priority: state.reminderDue <= nearest ? "urgent" : "routine",
      details: {
        memberId,
        ...subject,
        reminderDueOn: dueOn,
        reminderDays: state.reminderDue,
      },
    });
    raised += 1;
  };
  for (const memberId of members) {
    const { nation } = await memberRoles(tx, memberId, now);
    const rates = await workforceRates(tx, tenantId, nation, today);
    const record = await developmentRecord(tx, tenantId, memberId, now);
    if (!record) continue;
    for (const row of record.matrix) {
      if (row.validUntil && row.status !== "expired") {
        await raise(
          TRAINING_EXPIRY_TASK,
          memberId,
          { trainingTopic: row.topic },
          row.validUntil,
          rates,
        );
      }
    }
    for (const c of record.competences) {
      if (c.allowed && c.validUntil) {
        await raise(
          COMPETENCE_EXPIRY_TASK,
          memberId,
          { competence: c.competence },
          c.validUntil,
          rates,
        );
      }
    }
  }
  return raised;
}

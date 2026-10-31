import type { DevelopmentRecord, TrainingMatrix } from "@harbour/contracts";
import {
  competenceSignOff,
  competenceWithdrawal,
  location,
  revalidationEvidence,
  role,
  roleAssignment,
  staffProfile,
  supervisionNote,
  supervisionRecord,
  type Transaction,
  task,
  tenantUser,
  trainingRecord,
  trainingRequirement,
} from "@harbour/db";
import {
  COMPETENCES,
  type Competence,
  competenceDecision,
  expiryState,
  nextMeeting,
  PORTAL_ONLY_PERMISSIONS,
  reminderDays,
  revalidationPlan,
  type StoredSignOff,
  TRAINING_TOPICS,
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

type RequirementRow = typeof trainingRequirement.$inferSelect;

/** Every active requirement in the organisation, read with the system's rights. */
async function activeRequirements(tx: Transaction, roleKeys?: ReadonlySet<string>) {
  return withSystemRights(tx, () =>
    tx
      .select()
      .from(trainingRequirement)
      .where(
        and(
          eq(trainingRequirement.active, true),
          isNull(trainingRequirement.deletedAt),
          ...(roleKeys ? [inArray(trainingRequirement.roleKey, [...roleKeys])] : []),
        ),
      ),
  );
}

/** Requirements for a set of role keys, merged per topic (highest tier, shortest refresh). */
export function mergeRequirements(
  rows: readonly RequirementRow[],
  roleKeys: ReadonlySet<string>,
): TrainingRequirement[] {
  const byTopic = new Map<string, TrainingRequirement>();
  for (const r of rows) {
    if (!roleKeys.has(r.roleKey)) continue;
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

/** The organisation's requirements for a set of role keys, merged per topic. */
export async function requirementsFor(
  tx: Transaction,
  roleKeys: ReadonlySet<string>,
): Promise<TrainingRequirement[]> {
  if (roleKeys.size === 0) return [];
  return mergeRequirements(await activeRequirements(tx, roleKeys), roleKeys);
}

const trainingRates = (rates: WorkforceRates) => ({
  trainingDefaultRefreshYears: rates.trainingDefaultRefreshYears,
  oliverMcGowanRefreshYears: rates.oliverMcGowanRefreshYears,
  reminderDaysFirst: rates.reminderDaysFirst,
});

/** The nation whose figures apply to a member: where they work (England for organisation-wide roles). */
export async function memberNation(tx: Transaction, memberId: string, now: Date): Promise<Nation> {
  return (await memberRoles(tx, memberId, now)).nation;
}

/**
 * Whether the caller may read this member's development record, asked of the database before
 * anything is read with the system's rights (security review round 1, finding 1): the system, a
 * holder of a workforce read permission as the database counts it, or the member themselves.
 */
async function mayReadDevelopment(tx: Transaction, memberId: string): Promise<boolean> {
  const result = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.is_system() OR app.reads_development()
               OR app.reads_own_development(${memberId}::uuid) AS ok`,
  );
  return result.rows[0]?.ok === true;
}

/** One member's development record, as the caller's row-level security lets them read it. */
export async function developmentRecord(
  tx: Transaction,
  tenantId: string,
  memberId: string,
  now: Date,
): Promise<DevelopmentRecord | null> {
  if (!(await mayReadDevelopment(tx, memberId))) return null;
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
  // Notes as the caller's row-level security lets them read them: supervision holders and the
  // member only (migration 0114); everyone else gets none, without being told one exists.
  const notes =
    supervisions.length === 0
      ? []
      : await tx
          .select()
          .from(supervisionNote)
          .where(
            inArray(
              supervisionNote.supervisionId,
              supervisions.map((s) => s.id),
            ),
          );
  // The note in force is the one nothing supersedes; earlier ones are the corrected chain.
  const superseded = new Set(notes.flatMap((n) => (n.supersedesId ? [n.supersedesId] : [])));
  const notesFor = (supervisionId: string) => {
    const mine = notes
      .filter((n) => n.supervisionId === supervisionId)
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());
    return {
      current: mine.find((n) => !superseded.has(n.id)) ?? null,
      earlier: mine.filter((n) => superseded.has(n.id)),
    };
  };
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
    ...notes.map((n) => n.writtenBy),
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

  const held = supervisions.map((s) => ({
    kind: s.kind as "supervision" | "appraisal" | "spot_check",
    heldOn: s.heldOn,
  }));
  // From the last one held only: the start date is in the staff file, which these readers may not
  // see (security review round 1, finding 1); the first is due from the start (slice 57's screens).
  const next = (kind: "supervision" | "appraisal", perYear: number) => {
    const last = held
      .filter((h) => h.kind === kind && h.heldOn <= today)
      .map((h) => h.heldOn)
      .sort()
      .at(-1);
    return last ? nextMeeting(kind, held, last, perYear, today) : null;
  };

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
      ...(() => {
        const { current, earlier } = notesFor(s.id);
        const view = (n: (typeof notes)[number]) => ({
          discussion: n.discussion,
          actions: n.actions,
          writtenBy: names(n.writtenBy),
          writtenOn: ukIsoDate(n.createdAt),
        });
        return { note: current ? view(current) : null, earlierNotes: earlier.map(view) };
      })(),
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
  const left = new Set(
    (
      await tx
        .select({ id: staffProfile.tenantUserId })
        .from(staffProfile)
        .where(sql`${staffProfile.leftOn} IS NOT NULL AND ${staffProfile.leftOn} < ${today}`)
    ).map((r) => r.id),
  );
  for (const memberId of members) {
    // Leavers get no reminders (clinical safety review round 1, finding 8).
    if (left.has(memberId)) continue;
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

/**
 * Cancels a member's open reminders for one topic or competence once it is recorded again (a
 * renewal), so HR is not left with overdue tasks it need not act on (clinical safety review round
 * 1, finding 8); the new date's reminders follow from the sweep. With the system's rights, for
 * that member and subject only, because the reminders are about no person and no location.
 */
export function endDevelopmentReminders(
  tx: Transaction,
  memberId: string,
  subject: { readonly trainingTopic: string } | { readonly competence: string },
): Promise<number> {
  const [kind, key, value] =
    "trainingTopic" in subject
      ? [TRAINING_EXPIRY_TASK, "trainingTopic", subject.trainingTopic]
      : [COMPETENCE_EXPIRY_TASK, "competence", subject.competence];
  return withSystemRights(tx, async () => {
    const ended = await tx
      .update(task)
      .set({ status: "cancelled", statusReason: "Ended: recorded again" })
      .where(
        and(
          eq(task.kind, kind),
          eq(task.sourceType, "tenant_user"),
          eq(task.sourceId, memberId),
          inArray(task.status, ["open", "in_progress"]),
          sql`${task.details}->>${key} = ${value}`,
        ),
      )
      .returning({ id: task.id });
    return ended.length;
  });
}

/** The most members one matrix shows; more are filtered by location or role. */
export const MATRIX_MEMBER_LIMIT = 2000;

const PORTAL = sql.raw(`ARRAY[${PORTAL_ONLY_PERMISSIONS.map((p) => `'${p}'`).join(", ")}]::text[]`);

/**
 * The organisation's training matrix (slice 57; WORK-005): every member of staff whose roles need
 * training, each required topic's state today, by the same rules as one member's record. Read by
 * holders of the workforce read permissions only (asked of the database first); the members' roles
 * and places are read with the system's rights, as for one member, and their records under the
 * caller's own row-level security. Null when the caller may not read development records.
 */
export async function trainingMatrixFor(
  tx: Transaction,
  tenantId: string,
  now: Date,
  filter: { readonly locationId?: string; readonly roleKey?: string; readonly attention?: boolean },
): Promise<TrainingMatrix | null> {
  const allowed = await tx.execute<{ ok: boolean }>(
    sql`SELECT app.is_system() OR app.reads_development() AS ok`,
  );
  if (allowed.rows[0]?.ok !== true) return null;
  const today = ukIsoDate(now);
  const assignments = await withSystemRights(tx, () =>
    tx
      .select({
        memberId: roleAssignment.tenantUserId,
        displayName: tenantUser.displayName,
        key: role.key,
        basedOn: role.basedOnKey,
        locationId: roleAssignment.locationId,
        nation: location.nation,
      })
      .from(roleAssignment)
      // Composite keys, as ADR-0002 joins tenant rows.
      .innerJoin(
        role,
        and(eq(role.tenantId, roleAssignment.tenantId), eq(role.id, roleAssignment.roleId)),
      )
      .innerJoin(
        tenantUser,
        and(
          eq(tenantUser.tenantId, roleAssignment.tenantId),
          eq(tenantUser.id, roleAssignment.tenantUserId),
        ),
      )
      .leftJoin(
        location,
        and(
          eq(location.tenantId, roleAssignment.tenantId),
          eq(location.id, roleAssignment.locationId),
        ),
      )
      .where(
        and(
          isNull(roleAssignment.deletedAt),
          isNull(role.archivedAt),
          lte(roleAssignment.validFrom, now),
          or(isNull(roleAssignment.validTo), sql`${roleAssignment.validTo} > ${now}`),
          inArray(tenantUser.status, ["invited", "active"]),
          isNull(tenantUser.deletedAt),
          // Portal accounts (family, the person receiving care) are never staff on the matrix.
          sql`NOT (${role.permissions} && ${PORTAL})`,
        ),
      ),
  );
  const members = new Map<
    string,
    {
      displayName: string;
      keys: Set<string>;
      roles: Set<string>;
      locations: Set<string>;
      nation: Nation | null;
    }
  >();
  for (const a of assignments) {
    const m = members.get(a.memberId) ?? {
      displayName: a.displayName,
      keys: new Set<string>(),
      roles: new Set<string>(),
      locations: new Set<string>(),
      nation: null,
    };
    m.keys.add(a.key);
    m.roles.add(a.key);
    if (a.basedOn) m.keys.add(a.basedOn);
    if (a.locationId) m.locations.add(a.locationId);
    m.nation ??= (a.nation as Nation | null) ?? null;
    members.set(a.memberId, m);
  }
  const requirementRows = await activeRequirements(tx);
  const wanted = [...members.entries()]
    .filter(([, m]) => !filter.locationId || m.locations.has(filter.locationId))
    .filter(([, m]) => !filter.roleKey || m.keys.has(filter.roleKey))
    .map(([id, m]) => ({ id, ...m, requirements: mergeRequirements(requirementRows, m.keys) }))
    .filter((m) => m.requirements.length > 0)
    .sort(
      (x, y) => x.displayName.localeCompare(y.displayName, "en-GB") || x.id.localeCompare(y.id),
    );
  // Capped before any record is read, so the limit protects the database as well as the page
  // (security review round 1, low 2). The attention filter can only shorten the list.
  const truncated = wanted.length > MATRIX_MEMBER_LIMIT;
  const capped = wanted.slice(0, MATRIX_MEMBER_LIMIT);
  const ids = capped.map((m) => m.id);
  const records = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    records.push(
      ...(await tx
        .select({
          workerId: trainingRecord.workerId,
          topic: trainingRecord.topic,
          completedOn: trainingRecord.completedOn,
          expiresOn: trainingRecord.expiresOn,
          tier: trainingRecord.tier,
        })
        .from(trainingRecord)
        .where(and(inArray(trainingRecord.workerId, chunk), isNull(trainingRecord.deletedAt)))),
    );
  }
  const rates = new Map<Nation, WorkforceRates>();
  const ratesFor = async (nation: Nation) => {
    const found = rates.get(nation);
    if (found) return found;
    const loaded = await workforceRates(tx, tenantId, nation, today);
    rates.set(nation, loaded);
    return loaded;
  };
  const byWorker = new Map<string, typeof records>();
  for (const r of records) {
    const list = byWorker.get(r.workerId) ?? [];
    list.push(r);
    byWorker.set(r.workerId, list);
  }
  const names = await staffNames(tx, ids);
  const rows = [];
  for (const m of capped) {
    const member = names(m.id);
    if (!member) continue;
    const mine = byWorker.get(m.id) ?? [];
    const cells = trainingMatrix(
      m.requirements,
      mine.map((r) => ({
        topic: r.topic as TrainingTopic,
        completedOn: r.completedOn,
        expiresOn: r.expiresOn,
        ...(r.tier ? { tier: r.tier as 1 | 2 } : {}),
      })),
      today,
      trainingRates(await ratesFor(m.nation ?? "england")),
    ).map((cell) => ({
      topic: cell.topic,
      tier: (m.requirements.find((r) => r.topic === cell.topic)?.tier ?? null) as 1 | 2 | null,
      status: cell.status,
      validUntil: cell.validUntil,
    }));
    if (filter.attention && cells.every((cell) => cell.status === "valid")) continue;
    rows.push({ member, roles: [...m.roles].sort(), locationIds: [...m.locations].sort(), cells });
  }
  const shown = new Set(rows.flatMap((r) => r.cells.map((cell) => cell.topic)));
  return {
    asOf: today,
    topics: TRAINING_TOPICS.filter((topic) => shown.has(topic)),
    members: rows,
    truncated,
  };
}

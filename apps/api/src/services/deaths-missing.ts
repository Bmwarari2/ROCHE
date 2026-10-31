import {
  aboutMe,
  allergy,
  auditEvent,
  deathRecord,
  deathStep,
  exitRecord,
  herbertProfile,
  location,
  type missingEpisode,
  missingEvent,
  notification,
  person,
  statutoryNotification,
  type Transaction,
  task,
} from "@harbour/db";
import {
  addUkDays,
  type DeathStep,
  deathRecordView,
  herbertPrefill,
  herbertReviewDueOn,
  LIVE_PERSON_STATUSES,
  type MissingTimelineKind,
  missingEpisodeView,
  NOTIFICATION_DEATH_STEPS,
  type NotificationStatus,
  type RateNation,
  resolveSafetyPhase2Rates,
  SAFETY_PHASE2_RATE_KEYS,
  type SafetyPhase2Rates,
  type StatutoryNotificationKind,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { notificationsForExit } from "./death-notifications";
import { rateNumber, rateRows } from "./rates";
import { roleHolders } from "./role-holders";
import { permissionHolders } from "./safety";

/**
 * Deaths and missing persons (Phase 2 slice 37; SAFE-014, SAFE-015; safety.md slice 37; HZ-013,
 * HZ-127). The death record opens from the people lifecycle's `people.person.died` event (and on
 * request, for an exit the worker has not reached yet) and is withdrawn when the death is
 * corrected as recorded in error. A missing person episode raises a task for the police call at
 * its target, which the task engine escalates when overdue; a Herbert Protocol profile past its
 * review gets a review task.
 */

type DeathRow = typeof deathRecord.$inferSelect;
type EpisodeRow = typeof missingEpisode.$inferSelect;

/** The task to call the police about a missing person, due at the police call target (HZ-127). */
export const POLICE_CALL_TASK_KIND = "safety.missing_police_call";
/** The task to review a Herbert Protocol profile that is out of date (HZ-127). */
export const HERBERT_REVIEW_TASK_KIND = "safety.herbert_profile_review";
/** Prompts a Herbert Protocol profile for someone at risk of going missing (H-773). */
export const HERBERT_PREPARE_TASK_KIND = "safety.herbert_profile_prepare";
/** How long a prompt to prepare a profile has before it is due (rates.md). */
export const HERBERT_PREPARE_RATE_KEY = "herbert_protocol.prepare_due_days";

/** The Phase 2 safety figures in force on a date, for a nation (England until the nation packs). */
export async function phase2Rates(
  tx: Transaction,
  tenantId: string,
  on: string,
  nation: Exclude<RateNation, "uk" | "all"> = "england",
): Promise<SafetyPhase2Rates> {
  return resolveSafetyPhase2Rates(
    await rateRows(tx, Object.values(SAFETY_PHASE2_RATE_KEYS)),
    nation,
    on,
    tenantId,
  );
}

const nationOf = (value: string | null | undefined): Exclude<RateNation, "uk" | "all"> =>
  value === "wales" || value === "scotland" || value === "northern_ireland" ? value : "england";

// ------------------------------------------------------------------------------------------------
// Deaths
// ------------------------------------------------------------------------------------------------

/**
 * Opens the death record for a death recorded on an exit, once (the exit is its key): the time of
 * death, the clinician's judgement as the exit recorded it (whether the death was expected; whether
 * the cause may be unnatural is left to be recorded), and the mortality review's due date from the
 * rate table. Returns the record's id, or null when the exit is not a recorded death.
 */
export async function openDeathRecord(
  tx: Transaction,
  tenantId: string,
  exitRecordId: string,
): Promise<string | null> {
  const [found] = await tx
    .select({ exit: exitRecord, nation: location.nation })
    .from(exitRecord)
    .innerJoin(location, eq(location.id, exitRecord.locationId))
    .where(and(eq(exitRecord.id, exitRecordId), eq(exitRecord.kind, "death")));
  const exit = found?.exit;
  if (!exit?.leftAt || exit.state === "cancelled") return null;
  const rates = await phase2Rates(tx, tenantId, ukIsoDate(exit.leftAt), nationOf(found?.nation));
  await tx
    .insert(deathRecord)
    .values({
      personId: exit.personId,
      locationId: exit.locationId,
      exitRecordId: exit.id,
      diedAt: exit.leftAt,
      expected: exit.deathExpected,
      learningDisabilityOrAutism: exit.learningDisabilityOrAutism,
      reviewDueAt: addUkDays(exit.leftAt, rates.mortalityReviewDueDays),
    })
    .onConflictDoNothing({ target: [deathRecord.tenantId, deathRecord.exitRecordId] });
  const [row] = await tx
    .select({ id: deathRecord.id })
    .from(deathRecord)
    .where(eq(deathRecord.exitRecordId, exit.id));
  return row?.id ?? null;
}

/** A death corrected as recorded in error: its open record is withdrawn, never deleted. */
export async function withdrawDeathRecord(tx: Transaction, exitRecordId: string): Promise<number> {
  const withdrawn = await tx
    .update(deathRecord)
    .set({
      status: "withdrawn",
      withdrawnReason: "The death was recorded in error and has been corrected.",
    })
    .where(and(eq(deathRecord.exitRecordId, exitRecordId), eq(deathRecord.status, "open")))
    .returning({ id: deathRecord.id });
  return withdrawn.length;
}

/** Everything the death record's view needs, read in one place. */
export async function readDeath(tx: Transaction, tenantId: string, row: DeathRow, now: Date) {
  const steps = await tx
    .select()
    .from(deathStep)
    .where(eq(deathStep.deathRecordId, row.id))
    .orderBy(asc(deathStep.recordedAt), asc(deathStep.id));
  const [exit] = await tx.select().from(exitRecord).where(eq(exitRecord.id, row.exitRecordId));
  const notifications = exit
    ? await notificationsForExit(tx, exit)
    : new Map<StatutoryNotificationKind, typeof statutoryNotification.$inferSelect>();
  const [place] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, row.locationId));
  const rates = await phase2Rates(tx, tenantId, ukIsoDate(row.diedAt), nationOf(place?.nation));
  const statuses: Partial<Record<StatutoryNotificationKind, NotificationStatus>> = {};
  for (const [kind, n] of notifications) statuses[kind] = n.status as NotificationStatus;
  const view = deathRecordView({
    facts: {
      diedAt: row.diedAt,
      expected: row.expected,
      possiblyUnnatural: row.possiblyUnnatural,
      learningDisabilityOrAutism: row.learningDisabilityOrAutism,
    },
    recorded: steps.map((s) => ({
      step: s.step as DeathStep,
      outcome: s.outcome as "done" | "not_needed",
      at: s.at,
    })),
    notifications: statuses,
    review: {
      findings: row.reviewFindings,
      lessons: row.reviewLessons,
      reviewedAt: row.reviewedAt,
    },
    now,
    rates,
  });
  return { view, steps, notifications };
}

/** The death record as the API returns it. */
export function deathItem(row: DeathRow, read: Awaited<ReturnType<typeof readDeath>>, now: Date) {
  const { view, steps, notifications } = read;
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    exitRecordId: row.exitRecordId,
    incidentId: row.incidentId,
    diedAt: row.diedAt.toISOString(),
    expected: row.expected,
    possiblyUnnatural: row.possiblyUnnatural,
    judgedBy: row.judgedBy,
    learningDisabilityOrAutism: row.learningDisabilityOrAutism,
    status: row.status as "open" | "closed" | "withdrawn",
    missingFacts: [...view.missingFacts],
    steps: view.steps.map((s) => {
      const kind = NOTIFICATION_DEATH_STEPS[s.step];
      return {
        step: s.step,
        state: s.state,
        at: s.at ? s.at.toISOString() : null,
        notificationId: kind ? (notifications.get(kind)?.id ?? null) : null,
        notificationStatus: s.notificationStatus,
        reason: s.reason,
      };
    }),
    history: steps.map((s) => ({
      id: s.id,
      step: s.step as DeathStep,
      outcome: s.outcome as "done" | "not_needed",
      at: s.at.toISOString(),
      note: s.note,
      reference: s.reference,
      recordedAt: s.recordedAt.toISOString(),
      recordedBy: s.recordedBy,
    })),
    review: {
      // The due date fixed when the record opened, as stored.
      dueAt: row.reviewDueAt.toISOString(),
      overdue: !row.reviewedAt && now > row.reviewDueAt,
      findings: row.reviewFindings,
      lessons: row.reviewLessons,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewedBy: row.reviewedBy,
    },
    closeProblems: row.status === "open" ? [...view.closeProblems] : [],
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    withdrawnReason: row.withdrawnReason,
    version: row.version,
  };
}

// ------------------------------------------------------------------------------------------------
// Missing persons
// ------------------------------------------------------------------------------------------------

/** The notifications a missing person incident prompts, as the notification centre has them. */
const EPISODE_NOTIFICATION_KINDS: readonly StatutoryNotificationKind[] = [
  "police_missing_person",
  "cqc_reg18_police",
];

/** Everything the episode's view needs, read in one place. */
export async function readEpisode(tx: Transaction, tenantId: string, row: EpisodeRow, now: Date) {
  const events = await tx
    .select()
    .from(missingEvent)
    .where(eq(missingEvent.episodeId, row.id))
    .orderBy(asc(missingEvent.at), asc(missingEvent.recordedAt));
  const [profile] = await tx
    .select({ reviewedOn: herbertProfile.reviewedOn })
    .from(herbertProfile)
    .where(and(eq(herbertProfile.personId, row.personId), isNull(herbertProfile.deletedAt)));
  const [place] = await tx
    .select({ nation: location.nation })
    .from(location)
    .where(eq(location.id, row.locationId));
  const rates = await phase2Rates(tx, tenantId, ukIsoDate(now), nationOf(place?.nation));
  const notifications = await tx
    .select({
      id: statutoryNotification.id,
      kind: statutoryNotification.kind,
      status: statutoryNotification.status,
    })
    .from(statutoryNotification)
    .where(
      and(
        eq(statutoryNotification.incidentId, row.incidentId),
        inArray(statutoryNotification.kind, [...EPISODE_NOTIFICATION_KINDS]),
        isNull(statutoryNotification.deletedAt),
      ),
    );
  const view = missingEpisodeView({
    status: row.status as "open" | "found" | "closed",
    timeline: events.map((e) => ({
      kind: e.kind as MissingTimelineKind,
      at: e.at,
      reference: e.reference,
      area: e.area,
      note: e.note,
    })),
    underDolsOrMha: row.underDolsOrMha,
    immediateRisk: row.immediateRisk,
    herbertProfileReviewedOn: profile ? new Date(`${profile.reviewedOn}T00:00:00Z`) : null,
    now,
    rates,
  });
  return { view, events, notifications, rates };
}

/** The episode as the API returns it. */
export function episodeItem(row: EpisodeRow, read: Awaited<ReturnType<typeof readEpisode>>) {
  const { view, events, notifications } = read;
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    incidentId: row.incidentId,
    status: row.status as "open" | "found" | "closed",
    immediateRisk: row.immediateRisk,
    underDolsOrMha: row.underDolsOrMha,
    timeline: events.map((e) => ({
      id: e.id,
      kind: e.kind as MissingTimelineKind,
      at: e.at.toISOString(),
      reference: e.reference,
      area: e.area,
      note: e.note,
      recordedAt: e.recordedAt.toISOString(),
      recordedBy: e.recordedBy,
    })),
    policeCallDueAt: view.policeCallDueAt ? view.policeCallDueAt.toISOString() : null,
    policeCallLate: view.policeCallLate,
    policeReference: view.policeReference,
    cqcNotificationPrompt: view.cqcNotificationPrompt,
    herbertProfile: view.herbertProfile,
    herbertProfileVersionAtOpening: row.herbertProfileVersion,
    notifications: notifications.map((n) => ({
      id: n.id,
      kind: n.kind,
      status: n.status as NotificationStatus,
    })),
    closeProblems: row.status === "closed" ? [] : [...view.closeProblems],
    canClose: row.status !== "closed" && view.canClose,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    version: row.version,
  };
}

/**
 * Keeps the police call task in step with the episode (HZ-127): while the person is missing and
 * the police have not been called, one urgent task for the Registered Manager, due at the police
 * call target (at once when the risk assessment says so), which the task engine escalates when it
 * is overdue; once the police are called or the person is found, it is done.
 */
export async function syncPoliceCallTask(
  tx: Transaction,
  row: EpisodeRow,
  dueAt: Date | null,
  now: Date,
): Promise<void> {
  const [open] = await tx
    .select({ id: task.id, dueAt: task.dueAt })
    .from(task)
    .where(
      and(
        eq(task.kind, POLICE_CALL_TASK_KIND),
        eq(task.sourceType, "missing_episode"),
        eq(task.sourceId, row.id),
        inArray(task.status, ["open", "in_progress"]),
        isNull(task.deletedAt),
      ),
    )
    .limit(1);
  if (!dueAt || row.status !== "open") {
    if (open) {
      await tx
        .update(task)
        .set({
          status: "done",
          completedAt: now,
          statusReason: "The police were called, or the person was found",
        })
        .where(eq(task.id, open.id));
    }
    return;
  }
  if (open) {
    if (open.dueAt.getTime() !== dueAt.getTime()) {
      await tx.update(task).set({ dueAt }).where(eq(task.id, open.id));
    }
    return;
  }
  await tx.insert(task).values({
    kind: POLICE_CALL_TASK_KIND,
    title: "Call the police about a missing person, or record that they were found",
    requiredPermission: "safety.incident.report",
    locationId: row.locationId,
    personId: row.personId,
    sourceType: "missing_episode",
    sourceId: row.id,
    assigneeRoleKey: "registered_manager",
    dueAt,
    priority: "urgent",
  });
}

/** The roles told at once when an episode opens with immediate risk (H-771). */
export const IMMEDIATE_RISK_ROLES = ["clinical_lead", "team_leader"] as const;
export const MISSING_IMMEDIATE_KIND = "safety.missing.immediate_risk";
export const MISSING_IMMEDIATE_UNROUTED_ACTION = "safety.missing.immediate_risk_unrouted";

/**
 * An episode opened with immediate risk tells, at once, through the notification centre and
 * without waiting for the police call task's escalation, every holder of the clinical lead or
 * team leader role at the location (H-771, recommended answer applied 31/10/2026; HZ-127). No rota
 * exists yet, so "on site" means holding the role there, not being on shift (CSO decision logged
 * under H-771). Nobody holding those roles falls back to the Registered Manager, then to anyone who
 * manages incidents there; nobody at all is audited as unrouted, never passed over silently
 * (clinical review finding 1). Urgent, so quiet hours never hold it; generic words only, the link
 * opens the episode. Staff call 999 themselves: the target is never a reason to wait. Returns how
 * many were told.
 */
export async function tellOnSiteNow(tx: Transaction, row: EpisodeRow, now: Date): Promise<number> {
  let recipients = await roleHolders(tx, IMMEDIATE_RISK_ROLES, [row.locationId], now);
  if (recipients.length === 0) {
    recipients = await roleHolders(tx, ["registered_manager"], [row.locationId], now);
  }
  if (recipients.length === 0) {
    recipients = await permissionHolders(tx, "safety.incident.manage", row.locationId, now);
  }
  if (recipients.length === 0) {
    await tx.insert(auditEvent).values({
      tenantId: row.tenantId,
      action: MISSING_IMMEDIATE_UNROUTED_ACTION,
      outcome: "error",
      resourceType: "missing_episode",
      resourceId: row.id,
      reason: "no_recipient",
      scope: { reasonCode: "no_recipient", locationId: row.locationId },
    });
    return 0;
  }
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: MISSING_IMMEDIATE_KIND,
        severity: "urgent",
        title: "A person is missing and at immediate risk",
        body: "Call 999 now if no one has. Open the episode to see what is known.",
        link: `/missing/${row.id}`,
        channels: ["in_app", "push"],
        sourceType: "missing_episode",
        sourceId: row.id,
        personId: row.personId,
        locationId: row.locationId,
        dedupeKey: `missing_immediate:${row.id}:${recipient}`,
      })
      .onConflictDoNothing();
  }
  return recipients.length;
}

// ------------------------------------------------------------------------------------------------
// The Herbert Protocol profile
// ------------------------------------------------------------------------------------------------

/** A new profile prefilled from the person's record (`herbertPrefill`), never saved as it is. */
export async function herbertPrefillFor(tx: Transaction, personId: string) {
  const [p] = await tx.select().from(person).where(eq(person.id, personId));
  const [about] = await tx
    .select({ sections: aboutMe.sections })
    .from(aboutMe)
    .where(eq(aboutMe.personId, personId));
  const allergies = await tx
    .select({ substance: allergy.substance })
    .from(allergy)
    .where(and(eq(allergy.personId, personId), isNull(allergy.deletedAt)));
  const sections = (about?.sections ?? {}) as Record<string, { text?: string | null } | null>;
  const section = (key: string) => sections[key]?.text ?? null;
  const needs = Array.isArray(p?.communicationNeeds)
    ? (p.communicationNeeds as unknown[]).flatMap((n) => {
        const text = (n as { display?: unknown } | null)?.display;
        return typeof text === "string" && text.trim() ? [text.trim()] : [];
      })
    : [];
  return herbertPrefill({
    addressLines: [p?.addressLine1, p?.addressLine2, p?.town, p?.postcode].filter(
      (l): l is string => Boolean(l?.trim()),
    ),
    communicationNeeds: needs,
    firstLanguage: p?.firstLanguage ?? null,
    interpreterRequired: p?.interpreterRequired ?? false,
    aboutMe: {
      howICommunicate: section("how_i_communicate"),
      peopleWhoAreImportant: section("people_who_are_important_to_me"),
      pleaseDoAndDoNot: section("please_do_and_please_do_not"),
      howAndWhenToSupportMe: section("how_and_when_to_support_me"),
    },
    allergies: allergies.map((a) => a.substance),
  });
}

/** Marks the person's prompt to prepare a profile done once one is saved (H-773). */
export async function finishHerbertPrepareTasks(
  tx: Transaction,
  personId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(task)
    .set({ status: "done", completedAt: now, statusReason: "A profile was prepared" })
    .where(
      and(
        eq(task.kind, HERBERT_PREPARE_TASK_KIND),
        eq(task.personId, personId),
        inArray(task.status, ["open", "in_progress"]),
      ),
    );
}

/**
 * A Herbert Protocol profile is expected, prompted but never forced, for anyone whose record shows
 * a risk of going missing (H-773, recommended answer applied 31/10/2026; HZ-127): a person living
 * here with an active risk assessment for leaving without staff knowing (`absconding`) and no
 * profile gets one task for the nurse in charge, to prepare it with them or their representative.
 * It is raised once per assessment date, so a review prompts again but a correction does not, and
 * a task closed without a profile is never raised every day; it is due after
 * `herbert_protocol.prepare_due_days`, and closed when no longer needed. Dementia is not yet a structured field in
 * the record; until it is, the risk assessment is what prompts (H-773 note). Returns the tasks
 * raised.
 */
export async function raiseHerbertPreparations(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const atRisk = await tx.execute<{
    person_id: string;
    location_id: string;
    assessed_on: string;
  }>(sql`
    SELECT p.id AS person_id, p.location_id, max(r.assessed_on) AS assessed_on
      FROM risk_assessment r
      JOIN person p ON p.id = r.person_id
     WHERE r.template_key = 'absconding' AND r.status = 'active' AND r.deleted_at IS NULL
       AND p.deleted_at IS NULL
       AND p.status::text IN (${sql.join(
         LIVE_PERSON_STATUSES.map((status) => sql`${status}`),
         sql`, `,
       )})
       AND NOT EXISTS (SELECT 1 FROM herbert_profile h
                        WHERE h.person_id = p.id AND h.deleted_at IS NULL)
     GROUP BY p.id, p.location_id`);
  const dueDays = await rateNumber(tx, tenantId, HERBERT_PREPARE_RATE_KEY);
  let raised = 0;
  for (const row of atRisk.rows) {
    // Once per assessment date: a correction to the same assessment never prompts again.
    const assessedFrom = new Date(`${String(row.assessed_on).slice(0, 10)}T00:00:00Z`);
    const [already] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.kind, HERBERT_PREPARE_TASK_KIND),
          eq(task.personId, row.person_id),
          isNull(task.deletedAt),
          sql`${task.createdAt} >= ${assessedFrom}`,
        ),
      )
      .limit(1);
    if (already) continue;
    await tx.insert(task).values({
      kind: HERBERT_PREPARE_TASK_KIND,
      title: "Prepare a Herbert Protocol profile with the person or their representative",
      requiredPermission: "safety.incident.manage",
      locationId: row.location_id,
      personId: row.person_id,
      sourceType: "person",
      sourceId: row.person_id,
      assigneeRoleKey: "clinical_lead",
      // Prompted, never forced: due after the organisation's period, not overdue at once.
      dueAt: new Date(now.getTime() + dueDays * 86_400_000),
      priority: "routine",
    });
    raised++;
  }
  // Prompts no longer needed (the person left, or the risk assessment closed) are closed.
  await tx.execute(sql`
    UPDATE task SET status = 'cancelled', status_reason = 'No longer needed: the person left or the risk assessment closed'
     WHERE kind = ${HERBERT_PREPARE_TASK_KIND} AND status IN ('open', 'in_progress') AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM risk_assessment r JOIN person p ON p.id = r.person_id
          WHERE r.person_id = task.person_id AND r.template_key = 'absconding' AND r.status = 'active'
            AND r.deleted_at IS NULL AND p.deleted_at IS NULL
            AND p.status::text IN (${sql.join(
              LIVE_PERSON_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )}))`);
  return raised;
}

/** Marks a profile's review task done once the profile is reviewed. */
export async function finishHerbertReviewTasks(
  tx: Transaction,
  profileId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(task)
    .set({ status: "done", completedAt: now, statusReason: "The profile was reviewed" })
    .where(
      and(
        eq(task.kind, HERBERT_REVIEW_TASK_KIND),
        eq(task.sourceType, "herbert_profile"),
        eq(task.sourceId, profileId),
        inArray(task.status, ["open", "in_progress"]),
      ),
    );
}

/**
 * Herbert Protocol profiles past their review (`herbert_protocol.review_months` after the last
 * review) for people still living here get one review task each for the nurse in charge, which
 * the task engine escalates when overdue (HZ-127). Returns the tasks raised.
 */
export async function raiseHerbertReviews(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<number> {
  const today = ukIsoDate(now);
  const rates = await phase2Rates(tx, tenantId, today);
  const profiles = await tx
    .select({
      id: herbertProfile.id,
      personId: herbertProfile.personId,
      reviewedOn: herbertProfile.reviewedOn,
      locationId: person.locationId,
    })
    .from(herbertProfile)
    .innerJoin(person, eq(person.id, herbertProfile.personId))
    .where(
      and(
        isNull(herbertProfile.deletedAt),
        isNull(person.deletedAt),
        inArray(person.status, [...LIVE_PERSON_STATUSES]),
        // Only those that could be due: reviewed at least the review months ago, roughly.
        lte(
          herbertProfile.reviewedOn,
          sql`(${today}::date - make_interval(months => ${rates.herbertProtocolReviewMonths}))::date + 1`,
        ),
      ),
    );
  let raised = await raiseHerbertPreparations(tx, tenantId, now);
  for (const p of profiles) {
    if (herbertReviewDueOn(p.reviewedOn, rates.herbertProtocolReviewMonths) > today) continue;
    const [open] = await tx
      .select({ id: task.id })
      .from(task)
      .where(
        and(
          eq(task.kind, HERBERT_REVIEW_TASK_KIND),
          eq(task.sourceType, "herbert_profile"),
          eq(task.sourceId, p.id),
          inArray(task.status, ["open", "in_progress"]),
          isNull(task.deletedAt),
        ),
      )
      .limit(1);
    if (open) continue;
    await tx.insert(task).values({
      kind: HERBERT_REVIEW_TASK_KIND,
      title: "Review the Herbert Protocol profile with the person and their family",
      requiredPermission: "safety.incident.manage",
      locationId: p.locationId,
      personId: p.personId,
      sourceType: "herbert_profile",
      sourceId: p.id,
      assigneeRoleKey: "clinical_lead",
      dueAt: now,
      priority: "routine",
    });
    raised++;
  }
  return raised;
}

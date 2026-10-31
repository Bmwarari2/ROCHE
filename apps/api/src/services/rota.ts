import { createHash } from "node:crypto";
import type { RotaCheck, StaffingComparisonItem, WorkerWorkingTime } from "@harbour/contracts";
import {
  agencyWorker,
  complianceItem,
  location,
  locationInduction,
  rosterOverride,
  type rota,
  shift,
  shiftAssignment,
  staffProfile,
  type Transaction,
  tenantUser,
} from "@harbour/db";
import {
  type AgencyConfirmation,
  agencyRosterChecks,
  blockerKey,
  type Competence,
  checkWorkingTime,
  combinedRosterDecision,
  compareStaffing,
  isCompetence,
  type Membership,
  MIN_OVERRIDE_JUSTIFICATION,
  noticeMinutes,
  overrideCovers,
  plannedWorkPeriods,
  type RosterBlocker,
  type RosteredShift,
  resolveWorkingTimeRates,
  rosterBlockers,
  rosterChecks,
  rotaDates,
  type ShiftKind,
  STAFFING_STATUS_WORDS,
  type StaffingSkill,
  staffingProvided,
  ukIsoDate,
  WORKING_TIME_RATE_KEYS,
  type WorkingTimeSetting,
  workingTimeWindow,
} from "@harbour/domain";
import type { z } from "@hono/zod-openapi";
import { and, eq, gt, gte, inArray, isNull, lt, ne } from "drizzle-orm";
import { assignmentsAway } from "./absence";
import { competencePort } from "./competence-port";
import { rateRows } from "./rates";
import { profileFacts, storedItem, workforceRates } from "./staff-files";
import { locationRequirement } from "./staffing-requirement";
import { withSystemRights } from "./system-rights";

/**
 * The rota's questions to the other modules (scheduling.md section 14; hazards HZ-123, HZ-124):
 * whether a member may work a shift (the staff file's checks and the competence port, through the
 * workforce rules), which dependency-scale skills they hold on a day, their working time with the
 * rota's shifts, and the pre-publish check that brings these together with the staffing
 * comparison. The staff file, sign-offs and other locations' shifts are read with the system's
 * rights and only the answer leaves here: never a DBS detail, a document or a training record.
 */

export type ShiftRow = typeof shift.$inferSelect;
export type AssignmentRow = typeof shiftAssignment.$inferSelect;
export type RotaRow = typeof rota.$inferSelect;
type Nation = "england" | "wales" | "scotland" | "northern_ireland";

export const BLOCKER_MESSAGES: Readonly<Record<RosterBlocker["kind"], string>> = {
  dbs: "No DBS check on record clears them for this work on the day.",
  dbs_supervised_only:
    "Their DBS position allows supervised work only, and this shift is not supervised.",
  right_to_work:
    "No right to work on record for the day. This cannot be overridden: illegal working is never allowed.",
  registration: "Their professional registration is not current on the day.",
  competence: "They are not signed off as competent for this on the day.",
  not_active:
    "They are not working for your organisation on the day (suspended, left, not yet started, or marked not to be booked). This cannot be overridden.",
};

export function blockerItems(blockers: readonly RosterBlocker[]) {
  return blockers.map((b) => ({
    key: blockerKey(b),
    kind: b.kind,
    competence: b.kind === "competence" ? b.competence : null,
    message: BLOCKER_MESSAGES[b.kind],
  }));
}

export type EligibilityDecision = ReturnType<typeof combinedRosterDecision>;

/**
 * The staff file's checks for a member on a UK date, read with the system's rights, with the figures
 * of the nation where the shift is (clinical safety review round 1, L6) and whether the member works
 * for the organisation on the day (security review round 1, H1).
 */
async function staffFileChecks(
  tx: Transaction,
  tenantId: string,
  workerId: string,
  day: string,
  shiftLocationId: string,
) {
  const { profile, items, member, agencyRow } = await withSystemRights(tx, async () => {
    const [m] = await tx
      .select({ status: tenantUser.status })
      .from(tenantUser)
      .where(eq(tenantUser.id, workerId));
    const [w] = await tx.select().from(agencyWorker).where(eq(agencyWorker.tenantUserId, workerId));
    const [p] = await tx
      .select()
      .from(staffProfile)
      .where(and(eq(staffProfile.tenantUserId, workerId), isNull(staffProfile.deletedAt)));
    const rows = p
      ? await tx
          .select()
          .from(complianceItem)
          .where(and(eq(complianceItem.staffProfileId, p.id), isNull(complianceItem.deletedAt)))
      : [];
    return { profile: p ?? null, items: rows, member: m ?? null, agencyRow: w ?? null };
  });
  // A bank or agency worker marked do not book is not working for the organisation (clinical
  // safety review of slice 27, H1): never rostered, never overridden.
  const membership: Membership = {
    status: agencyRow?.doNotBook
      ? "suspended"
      : ((member?.status ?? "left") as Membership["status"]),
    leftOn: profile?.leftOn ?? null,
    startsOn: profile?.startsOn ?? null,
  };
  // An agency worker's checks are the agency's written confirmation (scheduling.md section 15
  // rule 1); a bank worker's, like any member's, come from the staff file.
  if (agencyRow?.kind === "agency") {
    return {
      // The agency's DBS confirmation is all the organisation has: never overridden (H3).
      strictDbs: true,
      registrationBody: agencyRow.registrationBody,
      checks: agencyRosterChecks(
        {
          dbsConfirmedOn: agencyRow.dbsConfirmedOn,
          dbsEnhancedBarred: agencyRow.dbsEnhancedBarred,
          rightToWorkConfirmedOn: agencyRow.rightToWorkConfirmedOn,
          rightToWorkExpiresOn: agencyRow.rightToWorkExpiresOn,
          registrationBody: agencyRow.registrationBody as AgencyConfirmation["registrationBody"],
          registrationValidUntil: agencyRow.registrationValidUntil,
        },
        day,
        membership,
      ),
    };
  }
  const nation = await nationOfLocation(tx, shiftLocationId);
  const rates = await workforceRates(tx, tenantId, nation, day);
  return {
    strictDbs: false,
    registrationBody: profile?.registrationBody ?? null,
    checks: rosterChecks(
      profile ? profileFacts(profile) : null,
      items.map((i) => storedItem(i)),
      day,
      rates,
      membership,
    ),
  };
}

export async function nationOfLocation(
  tx: Transaction,
  locationId: string | null,
): Promise<Nation> {
  if (!locationId) return "england";
  const [row] = await withSystemRights(tx, () =>
    tx.select({ nation: location.nation }).from(location).where(eq(location.id, locationId)),
  );
  return (row?.nation as Nation | undefined) ?? "england";
}

/** The last instant of a shift, for the UK date it ends on (a night ends the next day). */
const lastInstant = (endsAt: Date) => new Date(endsAt.getTime() - 1);

/**
 * The rostering rule for a member on a shift (HZ-124): on every UK date the shift touches (a night
 * across an expiry date is checked on both; clinical safety review round 1, H1), whether the member
 * works for the organisation, the staff file's checks and every competence the shift needs from the
 * competence port, which blocks when the sign-off has lapsed by then or now (ADR-0085). An override
 * must name exactly the blockers the manager was shown (C3).
 */
export async function shiftEligibility(
  tx: Transaction,
  tenantId: string,
  row: Pick<ShiftRow, "startsAt" | "endsAt" | "requiredCompetences" | "supervised" | "locationId">,
  workerId: string,
  override: { justification: string; blockerKeys: readonly string[] } | null = null,
  now: Date = new Date(),
): Promise<EligibilityDecision> {
  const instants = [row.startsAt];
  const end = lastInstant(row.endsAt);
  if (ukIsoDate(end) !== ukIsoDate(row.startsAt)) instants.push(end);
  const perDay: RosterBlocker[][] = [];
  let strictDbs = false;
  for (const at of instants) {
    const { checks, strictDbs: strict } = await staffFileChecks(
      tx,
      tenantId,
      workerId,
      ukIsoDate(at),
      row.locationId,
    );
    const competences = [];
    for (const competence of row.requiredCompetences.filter(isCompetence)) {
      competences.push({
        competence,
        gate: await competencePort(tx, workerId, competence, at, now),
      });
    }
    strictDbs ||= strict;
    perDay.push([...rosterBlockers({ ...checks, competences, shiftSupervised: row.supervised })]);
  }
  return combinedRosterDecision(perDay, override, MIN_OVERRIDE_JUSTIFICATION, (b) =>
    strictDbs ? b.kind === "dbs" || b.kind === "dbs_supervised_only" : false,
  );
}

/**
 * The dependency-scale skills a member holds for a whole shift: a registered nurse when their role
 * is on the NMC register and the registration is current, medicines and moving and handling from
 * the competence port, each on every UK date the shift touches. Nothing yet records who may drive
 * (H-835) or which part of the NMC register a nurse is on (H-835), so nobody counts as a driver.
 */
export async function workerSkills(
  tx: Transaction,
  tenantId: string,
  workerId: string,
  row: Pick<ShiftRow, "startsAt" | "endsAt" | "locationId">,
  now: Date,
): Promise<StaffingSkill[]> {
  const instants = [row.startsAt, lastInstant(row.endsAt)];
  let nurse = true;
  for (const at of instants) {
    const { registrationBody, checks } = await staffFileChecks(
      tx,
      tenantId,
      workerId,
      ukIsoDate(at),
      row.locationId,
    );
    nurse &&=
      registrationBody === "nmc" && checks.registrationCurrent === true && checks.memberActive;
  }
  const held = async (c: Competence) => {
    for (const at of instants) {
      if (!(await competencePort(tx, workerId, c, at, now)).allowed) return false;
    }
    return true;
  };
  const skills: StaffingSkill[] = [];
  if (nurse) skills.push("registered_nurse");
  if (await held("medicines_administration")) skills.push("medicines_competent");
  if (await held("moving_and_handling_hoist")) skills.push("moving_and_handling");
  return skills;
}

/**
 * The working-time setting the check uses until slice 30 records each organisation's (H-832): no
 * derogation, rolling reference periods, the default night time, weekly rest each week. Without a
 * derogation, departures a care home may lawfully make show as breaches, never as allowed.
 */
export const DEFAULT_WORKING_TIME_SETTING: WorkingTimeSetting = {
  derogations: [],
  successiveReferencePeriodsFrom: null,
  agreedReferencePeriodWeeks: null,
  agreedNightReferencePeriodWeeks: null,
  agreedNightTime: null,
  weeklyRestBasis: "each_week",
  weeklyRestPeriodsFrom: null,
  weeklyRestMayIncludeDailyRest: false,
  hospitalOrSimilarEstablishment: false,
};

export const WORKING_TIME_NOTES = {
  setting:
    "Checked without your organisation's working-time setting or any opt-out, which are not recorded yet: a departure you may lawfully make shows as a breach.",
  planned:
    "Planned shifts only: hours before this rota come from earlier rotas, and planned breaks are placed in the middle of each shift.",
  advice: "This is advice. It does not stop the rota being published.",
  noDateOfBirth:
    "The staff file has no date of birth or start date, so the working time check cannot run. Add them to the staff file.",
} as const;

/**
 * A member's working time with their planned shifts (advice only; scheduling.md section 5): every
 * live assignment of theirs at any location from the reference period before the rota to its end,
 * read with the system's rights; only findings that touch the rota's dates are returned, with the
 * shift ids of this rota.
 */
export async function workingTimeFor(
  tx: Transaction,
  workerId: string,
  rotaRow: Pick<RotaRow, "startsOn" | "endsOn" | "locationId">,
  rotaShiftIds: ReadonlySet<string>,
): Promise<z.infer<typeof WorkerWorkingTime>> {
  const nation = await nationOfLocation(tx, rotaRow.locationId);
  const rates = resolveWorkingTimeRates(
    await rateRows(tx, Object.values(WORKING_TIME_RATE_KEYS)),
    nation,
    rotaRow.startsOn,
  );
  const lookBack = Math.max(rates.referencePeriodWeeks, rates.nightReferencePeriodWeeks);
  const { from, to, known } = workingTimeWindow(rotaRow.startsOn, rotaRow.endsOn, lookBack);
  const { profile, rows } = await withSystemRights(tx, async () => {
    const [p] = await tx
      .select({ dateOfBirth: staffProfile.dateOfBirth, startsOn: staffProfile.startsOn })
      .from(staffProfile)
      .where(and(eq(staffProfile.tenantUserId, workerId), isNull(staffProfile.deletedAt)));
    const shifts = await tx
      .select({
        id: shift.id,
        kind: shift.kind,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        breakMinutes: shift.breakMinutes,
      })
      .from(shiftAssignment)
      .innerJoin(shift, eq(shift.id, shiftAssignment.shiftId))
      .where(
        and(
          eq(shiftAssignment.workerId, workerId),
          isNull(shiftAssignment.deletedAt),
          isNull(shift.deletedAt),
          gte(shift.endsAt, from),
          lt(shift.startsAt, to),
        ),
      );
    return { profile: p ?? null, rows: shifts };
  });
  if (!profile?.dateOfBirth || !profile.startsOn) {
    return {
      workerId,
      status: "cannot_check",
      findings: [],
      notes: [WORKING_TIME_NOTES.noDateOfBirth, WORKING_TIME_NOTES.advice],
    };
  }
  // Whether the contract provides for work after 22:00 is not recorded until slice 30, so both of a
  // young worker's restricted windows are checked and every finding of either is shown (clinical
  // safety review round 1, M5); for an adult the two runs are the same.
  const run = (contractProvidesWorkAfter22: boolean) =>
    checkWorkingTime({
      worker: {
        dateOfBirth: profile.dateOfBirth as string,
        employmentStart: profile.startsOn as string,
        optOuts: [],
        designatedNightWorker: false,
        specialHazards: false,
        contractProvidesWorkAfter22,
      },
      setting: DEFAULT_WORKING_TIME_SETTING,
      periods: plannedWorkPeriods(
        rows.map((r) => ({
          id: r.id,
          kind: r.kind as ShiftKind,
          start: r.startsAt,
          end: r.endsAt,
          breakMinutes: r.breakMinutes,
        })),
      ),
      excludedDays: [],
      evaluateFrom: rotaRow.startsOn,
      evaluateTo: rotaRow.endsOn,
      known,
      rates,
    });
  const seen = new Set<string>();
  const report = {
    findings: [...run(false).findings, ...run(true).findings].filter((f) => {
      const key = `${f.rule}|${f.outcome}|${f.from.toISOString()}|${f.to.toISOString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
  return {
    workerId,
    status: "checked",
    findings: report.findings.map((f) => ({
      rule: f.rule,
      citation: f.citation,
      outcome: f.outcome,
      conditions: [...f.conditions],
      from: f.from.toISOString(),
      to: f.to.toISOString(),
      limitMinutes: f.limitMinutes,
      actualMinutes: f.actualMinutes,
      compensatoryRestMinutes: f.compensatoryRestMinutes,
      shiftIds: f.periodIds.filter((id) => rotaShiftIds.has(id)),
    })),
    notes: [WORKING_TIME_NOTES.setting, WORKING_TIME_NOTES.planned, WORKING_TIME_NOTES.advice],
  };
}

/** The live shifts of a rota with their live assignments and each assignment's overrides. */
export async function rotaShifts(tx: Transaction, rotaId: string) {
  const shifts = await tx
    .select()
    .from(shift)
    .where(and(eq(shift.rotaId, rotaId), isNull(shift.deletedAt)));
  const ids = shifts.map((s) => s.id);
  const assignments =
    ids.length === 0
      ? []
      : await tx
          .select()
          .from(shiftAssignment)
          .where(and(inArray(shiftAssignment.shiftId, ids), isNull(shiftAssignment.deletedAt)));
  const assignmentIds = assignments.map((a) => a.id);
  const overrides =
    assignmentIds.length === 0
      ? []
      : await tx
          .select({ assignmentId: rosterOverride.assignmentId, keys: rosterOverride.blockerKeys })
          .from(rosterOverride)
          .where(inArray(rosterOverride.assignmentId, assignmentIds));
  const overridden = new Map<string, string[]>();
  for (const o of overrides) {
    overridden.set(o.assignmentId, [...(overridden.get(o.assignmentId) ?? []), ...o.keys]);
  }
  shifts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : 1));
  // HZ-123: an assignment whose member is away on the shift needs cover (section 17 rule 7).
  const away = await assignmentsAway(
    tx,
    assignments.flatMap((a) => {
      const s = shifts.find((x) => x.id === a.shiftId);
      return s
        ? [{ assignmentId: a.id, workerId: a.workerId, startsAt: s.startsAt, endsAt: s.endsAt }]
        : [];
    }),
  );
  return {
    shifts,
    assignmentOf: (shiftId: string) => assignments.find((a) => a.shiftId === shiftId) ?? null,
    overriddenOf: (assignmentId: string) => [...new Set(overridden.get(assignmentId) ?? [])].sort(),
    coverNeededOf: (assignmentId: string) => away.has(assignmentId),
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The pre-publish check (HZ-123, HZ-124): for each date and dependency period, the rota against
 * the organisation's own requirement with the method and every warning; each worker's working
 * time; each assignment's eligibility again, with whether an override still covers it; and a
 * digest of all of it that publishing must send back. Callers require scheduling.rota.manage and
 * care.plan.read across the whole location first.
 */
export async function rotaCheck(
  tx: Transaction,
  tenantId: string,
  rotaRow: RotaRow,
  now: Date = new Date(),
): Promise<z.infer<typeof RotaCheck>> {
  const { shifts, assignmentOf, overriddenOf, coverNeededOf } = await rotaShifts(tx, rotaRow.id);
  const rotaShiftIds = new Set(shifts.map((s) => s.id));

  // Eligibility again for every assignment (HZ-124: a check can lapse after assigning).
  const eligibility: z.infer<typeof RotaCheck>["eligibility"] = [];
  for (const s of shifts) {
    const a = assignmentOf(s.id);
    if (!a) continue;
    const decision = await shiftEligibility(tx, tenantId, s, a.workerId, null, now);
    const blockers = decision.allowed ? [] : decision.blockers;
    eligibility.push({
      assignmentId: a.id,
      workerId: a.workerId,
      shiftId: s.id,
      date: ukIsoDate(s.startsAt),
      allowed: decision.allowed,
      blockers: blockerItems(blockers),
      overridable: decision.allowed || decision.overridable,
      covered: blockers.length === 0 || overrideCovers(overriddenOf(a.id), blockers),
    });
  }

  // Shifts of the neighbouring rotas at the location that reach into this rota's periods (a night
  // from the rota before, an early from the rota after) count too (clinical safety review round 1,
  // L1); they are read, never changed.
  const edges = workingTimeWindow(rotaRow.startsOn, rotaRow.endsOn, 0);
  const neighbours = await tx
    .select()
    .from(shift)
    .where(
      and(
        eq(shift.locationId, rotaRow.locationId),
        ne(shift.rotaId, rotaRow.id),
        isNull(shift.deletedAt),
        gt(shift.endsAt, edges.from),
        lt(shift.startsAt, edges.to),
      ),
    );
  const neighbourAssignments =
    neighbours.length === 0
      ? []
      : await tx
          .select()
          .from(shiftAssignment)
          .where(
            and(
              inArray(
                shiftAssignment.shiftId,
                neighbours.map((n) => n.id),
              ),
              isNull(shiftAssignment.deletedAt),
            ),
          );

  // Skills for each shift's whole length, from the workforce port.
  const rostered: RosteredShift[] = [];
  const all = [
    ...shifts.map((s) => ({ s, a: assignmentOf(s.id) })),
    ...neighbours.map((s) => ({
      s,
      a: neighbourAssignments.find((x) => x.shiftId === s.id) ?? null,
    })),
  ];
  // Neighbours' members away on their shift need cover too.
  const neighbourAway = await assignmentsAway(
    tx,
    neighbourAssignments.flatMap((a) => {
      const n = neighbours.find((x) => x.id === a.shiftId);
      return n
        ? [{ assignmentId: a.id, workerId: a.workerId, startsAt: n.startsAt, endsAt: n.endsAt }]
        : [];
    }),
  );
  const coverNeeded = (a: { readonly id: string }) =>
    coverNeededOf(a.id) || neighbourAway.has(a.id);
  const coverShiftIds = new Set<string>();
  for (const { s, a } of all) {
    // A member away on the shift is not on the floor: the shift counts as open (HZ-123).
    if (a && coverNeeded(a)) {
      coverShiftIds.add(s.id);
      rostered.push({
        id: s.id,
        kind: s.kind as ShiftKind,
        start: s.startsAt,
        end: s.endsAt,
        breakMinutes: s.breakMinutes,
        countsAsCare: s.countsAsCare,
        workerId: null,
        workerSkills: [],
      });
      continue;
    }
    rostered.push({
      id: s.id,
      kind: s.kind as ShiftKind,
      start: s.startsAt,
      end: s.endsAt,
      breakMinutes: s.breakMinutes,
      countsAsCare: s.countsAsCare,
      workerId: a?.workerId ?? null,
      workerSkills: a ? await workerSkills(tx, tenantId, a.workerId, s, now) : [],
    });
  }
  const overriddenShiftIds = new Set(
    eligibility.filter((e) => !e.allowed && e.covered).map((e) => e.shiftId),
  );

  // The staffing comparison per date and period (HZ-123).
  const staffing: z.infer<typeof StaffingComparisonItem>[] = [];
  for (const date of rotaDates(rotaRow.startsOn, rotaRow.endsOn)) {
    const { results } = await locationRequirement(tx, rotaRow.locationId, date, null, now);
    for (const requirement of results) {
      const period = requirement.period;
      const window = period ? { start: period.start, end: period.end } : null;
      const provided = window
        ? staffingProvided(rostered, window)
        : {
            careMinutes: 0,
            staffWithSkill: {},
            shiftIds: [],
            openShiftIds: [],
            notCareShiftIds: [],
            method: [],
          };
      const comparison = compareStaffing(requirement, provided);
      // The rota's own warnings on the period: never a plain "met" while one stands (M1).
      const own: string[] = [];
      const coverHere = provided.openShiftIds.filter((id) => coverShiftIds.has(id)).length;
      if (coverHere > 0) {
        own.push(
          `${coverHere} shift(s) in this period need cover: the member rostered is absent, so they are not counted.`,
        );
      }
      if (provided.openShiftIds.length - coverHere > 0) {
        own.push(
          `${provided.openShiftIds.length - coverHere} care shift(s) in this period have nobody on them and are not counted.`,
        );
      }
      const overriddenHere = provided.shiftIds.filter((id) => overriddenShiftIds.has(id)).length;
      if (overriddenHere > 0) {
        own.push(
          `${overriddenHere} member(s) in this period are on shift under a manager's override of the rostering rule.`,
        );
      }
      const status =
        comparison.status === "met" && own.length > 0 ? "met_with_warnings" : comparison.status;
      staffing.push({
        date,
        periodKey: period?.key ?? null,
        periodLabel: period?.label ?? null,
        start: iso(period?.start ?? null),
        end: iso(period?.end ?? null),
        status,
        word: STAFFING_STATUS_WORDS[status],
        requiredMinutes: comparison.requiredMinutes,
        figure: comparison.figure,
        providedMinutes: comparison.providedMinutes,
        shortMinutes: comparison.shortMinutes,
        skills: comparison.skills.map((g) => ({ ...g })),
        openShiftIds: [...provided.openShiftIds],
        source: comparison.source
          ? {
              scaleId: comparison.source.scaleId,
              scaleName: comparison.source.scaleName,
              versionNumber: comparison.source.versionNumber,
              approvedAt: iso(comparison.source.approvedAt),
            }
          : null,
        notice: comparison.notice,
        warnings: [...comparison.warnings, ...own],
        method: [...comparison.method, ...provided.method],
      });
    }
  }

  // Working time per worker (advice only).
  const workers = [
    ...new Set(shifts.map((s) => assignmentOf(s.id)?.workerId).filter((w): w is string => !!w)),
  ].sort();
  const workingTime = [];
  for (const w of workers) workingTime.push(await workingTimeFor(tx, w, rotaRow, rotaShiftIds));

  const openShiftIds = shifts.filter((s) => !assignmentOf(s.id)).map((s) => s.id);
  // Bank and agency workers with no induction at the location (scheduling.md section 15 rule 5).
  const assigned = shifts
    .map((s) => assignmentOf(s.id))
    .filter((a): a is AssignmentRow => a !== null);
  const agencyMembers =
    assigned.length === 0
      ? []
      : await withSystemRights(tx, () =>
          tx
            .select({ id: agencyWorker.tenantUserId })
            .from(agencyWorker)
            .where(
              inArray(agencyWorker.tenantUserId, [...new Set(assigned.map((a) => a.workerId))]),
            ),
        );
  const inducted =
    agencyMembers.length === 0
      ? []
      : await tx
          .select({ workerId: locationInduction.workerId })
          .from(locationInduction)
          .where(
            and(
              eq(locationInduction.locationId, rotaRow.locationId),
              inArray(
                locationInduction.workerId,
                agencyMembers.map((m) => m.id),
              ),
            ),
          );
  const inductionsDue = assigned
    .filter(
      (a) =>
        agencyMembers.some((m) => m.id === a.workerId) &&
        !inducted.some((i) => i.workerId === a.workerId),
    )
    .map((a) => a.id);
  const coverNeededAssignmentIds = shifts.flatMap((s) => {
    const a = assignmentOf(s.id);
    return a && coverNeededOf(a.id) ? [a.id] : [];
  });
  const blockedAssignmentIds = eligibility.filter((e) => !e.covered).map((e) => e.assignmentId);
  const periodsToAcknowledge = staffing
    .filter((p) => p.status === "below" || p.status === "incomplete" || p.status === "no_scale")
    .map((p) => (p.periodKey ? `${p.date}:${p.periodKey}` : p.date));
  const hasWarnings =
    staffing.some((s) => s.status !== "met") ||
    workingTime.some((w) => w.status === "cannot_check" || w.findings.length > 0) ||
    openShiftIds.length > 0 ||
    inductionsDue.length > 0 ||
    coverNeededAssignmentIds.length > 0 ||
    eligibility.some((e) => !e.allowed);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        rota: [rotaRow.id, rotaRow.version],
        shifts: shifts.map((s) => [s.id, s.version, assignmentOf(s.id)?.id ?? null]),
        eligibility,
        staffing: staffing.map((s) => [
          s.date,
          s.periodKey,
          s.status,
          s.requiredMinutes,
          s.providedMinutes,
          s.skills,
          s.source?.scaleId ?? null,
          s.source?.versionNumber ?? null,
          s.warnings,
        ]),
        periodsToAcknowledge,
        inductionsDue,
        coverNeededAssignmentIds,
        workingTime,
      }),
    )
    .digest("hex");
  const first = shifts[0]?.startsAt ?? null;
  return {
    rotaId: rotaRow.id,
    rotaVersion: rotaRow.version,
    digest,
    staffing,
    workingTime,
    eligibility,
    openShiftIds,
    inductionsDue,
    coverNeededAssignmentIds,
    hasWarnings,
    periodsToAcknowledge,
    blockedAssignmentIds,
    firstShiftStart: iso(first),
    noticeMinutes: noticeMinutes(now, first),
    asAt: now.toISOString(),
  };
}

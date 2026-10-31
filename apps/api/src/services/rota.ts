import { createHash } from "node:crypto";
import type { RotaCheck, StaffingComparisonItem, WorkerWorkingTime } from "@harbour/contracts";
import {
  complianceItem,
  location,
  rosterOverride,
  type rota,
  shift,
  shiftAssignment,
  staffProfile,
  type Transaction,
} from "@harbour/db";
import {
  blockerKey,
  type Competence,
  checkWorkingTime,
  compareStaffing,
  isCompetence,
  noticeMinutes,
  overrideCovers,
  plannedWorkPeriods,
  type RosterBlocker,
  type RosterDecision,
  type RosteredShift,
  resolveWorkingTimeRates,
  rosterChecks,
  rosterDecision,
  rotaDates,
  type ShiftKind,
  type StaffingSkill,
  staffingProvided,
  ukIsoDate,
  WORKING_TIME_RATE_KEYS,
  type WorkingTimeSetting,
  workingTimeWindow,
} from "@harbour/domain";
import type { z } from "@hono/zod-openapi";
import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
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
};

export function blockerItems(blockers: readonly RosterBlocker[]) {
  return blockers.map((b) => ({
    key: blockerKey(b),
    kind: b.kind,
    competence: b.kind === "competence" ? b.competence : null,
    message: BLOCKER_MESSAGES[b.kind],
  }));
}

/** The staff file's checks for a member on a UK date, read with the system's rights. */
async function staffFileChecks(tx: Transaction, tenantId: string, workerId: string, day: string) {
  const { profile, items } = await withSystemRights(tx, async () => {
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
    return { profile: p ?? null, items: rows };
  });
  const nation = await nationOfLocation(tx, profile?.locationId ?? null);
  const rates = await workforceRates(tx, tenantId, nation, day);
  return {
    profile,
    checks: rosterChecks(
      profile ? profileFacts(profile) : null,
      items.map((i) => storedItem(i)),
      day,
      rates,
    ),
  };
}

async function nationOfLocation(tx: Transaction, locationId: string | null): Promise<Nation> {
  if (!locationId) return "england";
  const [row] = await withSystemRights(tx, () =>
    tx.select({ nation: location.nation }).from(location).where(eq(location.id, locationId)),
  );
  return (row?.nation as Nation | undefined) ?? "england";
}

/**
 * The rostering rule for a member on a shift (HZ-124): the staff file's checks on the shift's UK
 * date and every competence the shift needs from the competence port, which blocks when the
 * sign-off has lapsed by the shift or now (ADR-0085).
 */
export async function shiftEligibility(
  tx: Transaction,
  tenantId: string,
  row: Pick<ShiftRow, "startsAt" | "requiredCompetences" | "supervised">,
  workerId: string,
  override: { justification: string; byTenantUserId: string } | null = null,
  now: Date = new Date(),
): Promise<RosterDecision> {
  const day = ukIsoDate(row.startsAt);
  const { checks } = await staffFileChecks(tx, tenantId, workerId, day);
  const competences = [];
  for (const competence of row.requiredCompetences.filter(isCompetence)) {
    competences.push({
      competence,
      gate: await competencePort(tx, workerId, competence, row.startsAt, now),
    });
  }
  return rosterDecision({ ...checks, competences, shiftSupervised: row.supervised }, override);
}

/**
 * The dependency-scale skills a member holds on a UK date: a registered nurse when their role is
 * on the NMC register and the registration is current; medicines and moving and handling from the
 * competence port. Nothing yet records who may drive (H-835), so nobody counts as a driver.
 */
export async function workerSkills(
  tx: Transaction,
  tenantId: string,
  workerId: string,
  at: Date,
  now: Date,
): Promise<StaffingSkill[]> {
  const day = ukIsoDate(at);
  const { profile, checks } = await staffFileChecks(tx, tenantId, workerId, day);
  const skills: StaffingSkill[] = [];
  if (profile?.registrationBody === "nmc" && checks.registrationCurrent === true) {
    skills.push("registered_nurse");
  }
  const held = async (c: Competence) => (await competencePort(tx, workerId, c, at, now)).allowed;
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
  const report = checkWorkingTime({
    worker: {
      dateOfBirth: profile.dateOfBirth,
      employmentStart: profile.startsOn,
      optOuts: [],
      designatedNightWorker: false,
      specialHazards: false,
      contractProvidesWorkAfter22: false,
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
  return {
    shifts,
    assignmentOf: (shiftId: string) => assignments.find((a) => a.shiftId === shiftId) ?? null,
    overriddenOf: (assignmentId: string) => [...new Set(overridden.get(assignmentId) ?? [])].sort(),
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
  const { shifts, assignmentOf, overriddenOf } = await rotaShifts(tx, rotaRow.id);
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

  // Skills per worker per day, from the workforce port.
  const skillCache = new Map<string, StaffingSkill[]>();
  const rostered: RosteredShift[] = [];
  for (const s of shifts) {
    const a = assignmentOf(s.id);
    let skills: StaffingSkill[] = [];
    if (a) {
      const cacheKey = `${a.workerId}:${ukIsoDate(s.startsAt)}`;
      skills =
        skillCache.get(cacheKey) ?? (await workerSkills(tx, tenantId, a.workerId, s.startsAt, now));
      skillCache.set(cacheKey, skills);
    }
    rostered.push({
      id: s.id,
      kind: s.kind as ShiftKind,
      start: s.startsAt,
      end: s.endsAt,
      breakMinutes: s.breakMinutes,
      workerId: a?.workerId ?? null,
      workerSkills: skills,
    });
  }

  // The staffing comparison per date and period (HZ-123).
  const staffing: z.infer<typeof StaffingComparisonItem>[] = [];
  for (const date of rotaDates(rotaRow.startsOn, rotaRow.endsOn)) {
    const { results } = await locationRequirement(tx, rotaRow.locationId, date, null, now);
    for (const requirement of results) {
      const period = requirement.period;
      const window = period ? { start: period.start, end: period.end } : null;
      const provided = window
        ? staffingProvided(rostered, window)
        : { careMinutes: 0, staffWithSkill: {}, openShiftIds: [], method: [] };
      const comparison = compareStaffing(requirement, provided);
      staffing.push({
        date,
        periodKey: period?.key ?? null,
        periodLabel: period?.label ?? null,
        start: iso(period?.start ?? null),
        end: iso(period?.end ?? null),
        status: comparison.status,
        word: comparison.word,
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
        warnings: [...comparison.warnings],
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
  const blockedAssignmentIds = eligibility.filter((e) => !e.covered).map((e) => e.assignmentId);
  const hasWarnings =
    staffing.some((s) => s.status !== "met") ||
    workingTime.some((w) => w.status === "cannot_check" || w.findings.length > 0) ||
    openShiftIds.length > 0 ||
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
          s.warnings,
        ]),
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
    hasWarnings,
    blockedAssignmentIds,
    firstShiftStart: iso(first),
    noticeMinutes: noticeMinutes(now, first),
    asAt: now.toISOString(),
  };
}

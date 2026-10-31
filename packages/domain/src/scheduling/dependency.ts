/**
 * The dependency tool and the required care hours per shift (scheduling.md section 12; CARE-004,
 * SCHED-001; hazard HZ-123). The scale is the organisation's own tool: its shift periods, its
 * categories with care minutes per period, its skill-mix minimums and its review interval are the
 * organisation's data, never Harbour's. These rules check the scale, keep each person's category
 * as an append-only chain, and add up the organisation's figures for the people at a location,
 * showing the method. They never assess a person, propose a category, score need or risk, or judge
 * whether staffing is safe (medical-device-boundary.md section 6). Pure functions, no I/O; every
 * figure comes from the scale (the scheduling source holds no figure as a literal).
 */

import { formatUkDate, formatUkDateTime, ukStartOfDay } from "../shared/time";
import {
  atMinuteOfDay,
  daysFrom,
  MINUTES_PER_DAY,
  MINUTES_PER_HOUR,
  minutesBetween,
  plusDays,
  ukDateOf,
} from "./intervals";

/** The skills a scale may set a minimum for on a period (master prompt 12.3). */
export const STAFFING_SKILLS = [
  "registered_nurse",
  "medicines_competent",
  "moving_and_handling",
  "driver",
] as const;
export type StaffingSkill = (typeof STAFFING_SKILLS)[number];

export const STAFFING_SKILL_LABELS: Readonly<Record<StaffingSkill, string>> = {
  registered_nurse: "Registered nurse",
  medicines_competent: "Competent to give medicines",
  moving_and_handling: "Trained in moving and handling",
  driver: "Driver",
};

export const DEPENDENCY_SCALE_STATES = ["draft", "approved", "superseded", "discarded"] as const;
export type DependencyScaleState = (typeof DEPENDENCY_SCALE_STATES)[number];

/** Where a version may go next (rule 2); the database holds the same workflow (migration 0074). */
export const DEPENDENCY_SCALE_WORKFLOW: Readonly<
  Record<DependencyScaleState, readonly DependencyScaleState[]>
> = {
  draft: ["approved", "discarded"],
  approved: ["superseded"],
  superseded: [],
  discarded: [],
};

export const DEPENDENCY_ASSESSMENT_KINDS = ["initial", "review", "correction"] as const;
export type DependencyAssessmentKind = (typeof DEPENDENCY_ASSESSMENT_KINDS)[number];

/** Shown with every required-hours figure and comparison (rule 12). */
export const DEPENDENCY_TOOL_NOTICE =
  "These hours come from your organisation's own dependency scale. Harbour adds up the figures your organisation set; it does not assess anyone's needs or judge safe staffing.";

export const STAFFING_STATUSES = ["below", "incomplete", "met", "no_scale"] as const;
export type StaffingStatus = (typeof STAFFING_STATUSES)[number];

/** The word shown beside each status's icon (status never by colour alone). */
export const STAFFING_STATUS_WORDS: Readonly<Record<StaffingStatus, string>> = {
  below: "Fewer hours or staff than your scale requires",
  incomplete: "Not complete: some people are not counted",
  met: "Meets the hours and staff your scale requires",
  no_scale: "No dependency scale in force",
};

export interface DependencyPeriod {
  readonly key: string;
  readonly label: string;
  /** Minutes after midnight, UK wall-clock time. */
  readonly startMinute: number;
}

export interface PeriodMinutes {
  readonly periodKey: string;
  readonly minutes: number;
}

export interface DependencyCategory {
  readonly key: string;
  readonly label: string;
  readonly description: string | null;
  /** Care minutes per person in each period. */
  readonly careMinutes: readonly PeriodMinutes[];
}

export interface SkillMinimum {
  readonly skill: StaffingSkill;
  readonly periodKey: string;
  readonly minimumStaff: number;
}

export interface DependencyScaleDefinition {
  readonly periods: readonly DependencyPeriod[];
  readonly categories: readonly DependencyCategory[];
  readonly skillMix: readonly SkillMinimum[];
  readonly reviewIntervalDays: number | null;
}

// ---------------------------------------------------------------------------------------------
// Rule 1: the definition
// ---------------------------------------------------------------------------------------------

export type ScaleProblem =
  | "no_periods"
  | "no_categories"
  | "invalid_key"
  | "duplicate_key"
  | "blank_label"
  | "period_start"
  | "period_order"
  | "care_minutes_missing"
  | "care_minutes_unknown_period"
  | "care_minutes_duplicate"
  | "care_minutes_invalid"
  | "skill_unknown"
  | "skill_period_unknown"
  | "skill_duplicate"
  | "skill_minimum_invalid"
  | "review_interval_invalid";

export const SCALE_PROBLEM_MESSAGES: Readonly<Record<ScaleProblem, string>> = {
  no_periods: "Add at least one shift period.",
  no_categories: "Add at least one category.",
  invalid_key:
    "Use lower case letters, digits and underscores for a key, starting with a letter (40 characters at most).",
  duplicate_key: "Each key can be used only once.",
  blank_label: "Give it a name.",
  period_start: "A period starts at a time between 00:00 and 23:59.",
  period_order: "List the periods in the order they start in the day, each later than the last.",
  care_minutes_missing: "Give the care minutes for every period.",
  care_minutes_unknown_period: "These care minutes are for a period the scale does not have.",
  care_minutes_duplicate: "Give the care minutes for each period once.",
  care_minutes_invalid: "Care minutes are a whole number, 0 or more.",
  skill_unknown: "Choose a skill from the list.",
  skill_period_unknown: "This minimum is for a period the scale does not have.",
  skill_duplicate: "Set each skill's minimum once for each period.",
  skill_minimum_invalid: "A minimum is a whole number of staff, 1 or more.",
  review_interval_invalid: "The review interval is a whole number of days, 1 or more, or none.",
};

export interface ScaleIssue {
  readonly problem: ScaleProblem;
  /** Where in the definition, for the form (`categories.1.careMinutes.0.minutes`). */
  readonly path: string;
  readonly message: string;
}

/** A key: lower case letters, digits and underscores, from a letter (40 characters at most). */
const KEY_SOURCE = "^[a-z][a-z0-9_]{0,39}$";
const KEY_PATTERN = new RegExp(KEY_SOURCE);

const wholeAtLeast = (value: number, least: number) => Number.isInteger(value) && value >= least;

/** Every problem with a scale definition; an empty list means it can be approved (rule 1). */
export function checkScaleDefinition(definition: DependencyScaleDefinition): ScaleIssue[] {
  const issues: ScaleIssue[] = [];
  const add = (problem: ScaleProblem, path: string) =>
    issues.push({ problem, path, message: SCALE_PROBLEM_MESSAGES[problem] });

  const checkKey = (key: string, seen: Set<string>, path: string) => {
    if (!KEY_PATTERN.test(key)) add("invalid_key", path);
    else if (seen.has(key)) add("duplicate_key", path);
    seen.add(key);
  };

  if (definition.periods.length === 0) add("no_periods", "periods");
  const periodKeys = new Set<string>();
  let previousStart: number | null = null;
  definition.periods.forEach((period, i) => {
    const path = `periods.${i}`;
    checkKey(period.key, periodKeys, `${path}.key`);
    if (period.label.trim() === "") add("blank_label", `${path}.label`);
    if (!wholeAtLeast(period.startMinute, 0) || period.startMinute >= MINUTES_PER_DAY) {
      add("period_start", `${path}.startMinute`);
      return;
    }
    if (previousStart !== null && period.startMinute <= previousStart) {
      add("period_order", `${path}.startMinute`);
    }
    previousStart = period.startMinute;
  });

  if (definition.categories.length === 0) add("no_categories", "categories");
  const categoryKeys = new Set<string>();
  definition.categories.forEach((category, i) => {
    const path = `categories.${i}`;
    checkKey(category.key, categoryKeys, `${path}.key`);
    if (category.label.trim() === "") add("blank_label", `${path}.label`);
    const given = new Set<string>();
    category.careMinutes.forEach((entry, j) => {
      const at = `${path}.careMinutes.${j}`;
      if (!periodKeys.has(entry.periodKey)) add("care_minutes_unknown_period", `${at}.periodKey`);
      else if (given.has(entry.periodKey)) add("care_minutes_duplicate", `${at}.periodKey`);
      given.add(entry.periodKey);
      if (!wholeAtLeast(entry.minutes, 0)) add("care_minutes_invalid", `${at}.minutes`);
    });
    if ([...periodKeys].some((key) => !given.has(key))) {
      add("care_minutes_missing", `${path}.careMinutes`);
    }
  });

  const skillRows = new Set<string>();
  definition.skillMix.forEach((row, i) => {
    const path = `skillMix.${i}`;
    if (!(STAFFING_SKILLS as readonly string[]).includes(row.skill)) add("skill_unknown", path);
    if (!periodKeys.has(row.periodKey)) add("skill_period_unknown", `${path}.periodKey`);
    const id = `${row.skill} ${row.periodKey}`;
    if (skillRows.has(id)) add("skill_duplicate", path);
    skillRows.add(id);
    if (!wholeAtLeast(row.minimumStaff, 1)) add("skill_minimum_invalid", `${path}.minimumStaff`);
  });

  if (definition.reviewIntervalDays !== null && !wholeAtLeast(definition.reviewIntervalDays, 1)) {
    add("review_interval_invalid", "reviewIntervalDays");
  }
  return issues;
}

/** A value with its object keys sorted, so a definition read back from jsonb compares equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

export function sameDefinition(
  a: DependencyScaleDefinition,
  b: DependencyScaleDefinition,
): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// ---------------------------------------------------------------------------------------------
// Rules 2 to 5: versions, approval and the version in force
// ---------------------------------------------------------------------------------------------

export interface ScaleVersionRecord {
  readonly id: string;
  readonly scaleId: string;
  readonly versionNumber: number;
  readonly state: DependencyScaleState;
  readonly definition: DependencyScaleDefinition;
  readonly authorId: string;
  /** The author and everyone who changed the draft. */
  readonly contributorIds: readonly string[];
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}

export type ScaleApprovalProblem =
  | "not_draft"
  | "invalid_scale"
  | "unchanged"
  | "author_cannot_approve";

export const SCALE_APPROVAL_MESSAGES: Readonly<Record<ScaleApprovalProblem, string>> = {
  not_draft: "Only a draft can be approved.",
  invalid_scale: "Put right the problems listed on the draft before it is approved.",
  unchanged: "This draft is the same as the version in use, so there is nothing to approve.",
  author_cannot_approve:
    "Someone who wrote or changed this draft cannot approve it. Ask another manager who can change the scale.",
};

/** Whether a member may approve a draft now (rule 4); an empty list means they may. */
export function checkScaleApproval(
  draft: ScaleVersionRecord,
  current: ScaleVersionRecord | null,
  approverId: string,
): ScaleApprovalProblem[] {
  const problems: ScaleApprovalProblem[] = [];
  if (draft.state !== "draft") problems.push("not_draft");
  if (checkScaleDefinition(draft.definition).length > 0) problems.push("invalid_scale");
  if (current && sameDefinition(current.definition, draft.definition)) problems.push("unchanged");
  if (draft.authorId === approverId || draft.contributorIds.includes(approverId)) {
    problems.push("author_cannot_approve");
  }
  return problems;
}

/** The version approved latest at or before an instant, or null before the first (rule 3). */
export function scaleVersionInForce(
  versions: readonly ScaleVersionRecord[],
  at: Date,
): ScaleVersionRecord | null {
  let found: ScaleVersionRecord | null = null;
  for (const version of versions) {
    if (version.state !== "approved" && version.state !== "superseded") continue;
    if (!version.approvedAt || version.approvedAt > at) continue;
    if (!found?.approvedAt || version.approvedAt > found.approvedAt) found = version;
  }
  return found;
}

export interface LiveScale {
  readonly id: string;
  /** Null for the organisation-wide scale. */
  readonly locationId: string | null;
}

/** The scale that applies at a location: its own, otherwise the organisation's (rule 5). */
export function scaleForLocation<S extends LiveScale>(
  scales: readonly S[],
  locationId: string,
): S | null {
  return (
    scales.find((s) => s.locationId === locationId) ??
    scales.find((s) => s.locationId === null) ??
    null
  );
}

// ---------------------------------------------------------------------------------------------
// Rule 8: shift periods on a date
// ---------------------------------------------------------------------------------------------

export interface PeriodWindow {
  readonly key: string;
  readonly label: string;
  readonly start: Date;
  readonly end: Date;
  /** Elapsed minutes: an hour more or less on the nights the clocks change. */
  readonly minutes: number;
}

/** Each period on a UK date, ending where the next starts (the last at the first, next day). */
export function periodWindows(
  periods: readonly DependencyPeriod[],
  isoDate: string,
): PeriodWindow[] {
  const first = periods[0];
  if (!first) return [];
  return periods.map((period, i) => {
    const next = periods[i + 1];
    const start = atMinuteOfDay(isoDate, period.startMinute);
    const end = next
      ? atMinuteOfDay(isoDate, next.startMinute)
      : atMinuteOfDay(plusDays(isoDate, 1), first.startMinute);
    return {
      key: period.key,
      label: period.label,
      start,
      end,
      minutes: minutesBetween(start, end),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Rules 6 and 7: a person's category, as an append-only chain
// ---------------------------------------------------------------------------------------------

export interface DependencyRecord {
  readonly id: string;
  readonly personId: string;
  readonly scaleId: string;
  readonly scaleVersionId: string;
  readonly categoryKey: string;
  readonly oneToOne: readonly PeriodMinutes[];
  readonly kind: DependencyAssessmentKind;
  /** The UK date it applies from. */
  readonly effectiveFrom: string;
  readonly supersedesId: string | null;
  readonly decidedBy: string;
  readonly reason: string;
  readonly recordedAt: Date;
}

/** The records in chain order, from the first to the person's current one. */
export function dependencyChain(records: readonly DependencyRecord[]): DependencyRecord[] {
  const next = new Map<string | null, DependencyRecord>();
  for (const record of records) next.set(record.supersedesId, record);
  const chain: DependencyRecord[] = [];
  let at = next.get(null);
  while (at && chain.length < records.length) {
    chain.push(at);
    at = next.get(at.id);
  }
  return chain;
}

/** The person's current record (the head of the chain), which a new record must supersede. */
export function currentDependency(records: readonly DependencyRecord[]): DependencyRecord | null {
  return dependencyChain(records).at(-1) ?? null;
}

/** The records a correction replaced: shown struck through, never in force. */
export function correctedDependencyIds(records: readonly DependencyRecord[]): Set<string> {
  return new Set(
    records
      .filter((r) => r.kind === "correction" && r.supersedesId !== null)
      .map((r) => r.supersedesId as string),
  );
}

/** The record in force at an instant (rule 7), or null. */
export function dependencyInForce(
  records: readonly DependencyRecord[],
  at: Date,
): DependencyRecord | null {
  const corrected = correctedDependencyIds(records);
  let found: DependencyRecord | null = null;
  for (const record of dependencyChain(records)) {
    if (corrected.has(record.id)) continue;
    if (ukStartOfDay(record.effectiveFrom) <= at) found = record;
  }
  return found;
}

export interface NewDependencyRecord {
  readonly kind: DependencyAssessmentKind;
  readonly categoryKey: string;
  readonly oneToOne: readonly PeriodMinutes[];
  readonly effectiveFrom: string;
  readonly reason: string;
  readonly decidedBy: string | null;
  readonly supersedesId: string | null;
}

export type DependencyProblem =
  | "no_scale"
  | "category_unknown"
  | "one_to_one_unknown_period"
  | "one_to_one_duplicate_period"
  | "one_to_one_invalid"
  | "reason_missing"
  | "decider_missing"
  | "effective_in_future"
  | "kind_mismatch"
  | "initial_exists"
  | "nothing_to_supersede"
  | "not_current"
  | "review_before_previous"
  | "correction_date_changed";

export const DEPENDENCY_PROBLEM_MESSAGES: Readonly<Record<DependencyProblem, string>> = {
  no_scale:
    "No dependency scale is approved for this person's location. Your organisation approves its scale first.",
  category_unknown: "Choose a category from the scale in use.",
  one_to_one_unknown_period: "One-to-one minutes are for a period the scale does not have.",
  one_to_one_duplicate_period: "Give the one-to-one minutes for each period once.",
  one_to_one_invalid: "One-to-one minutes are a whole number, more than 0.",
  reason_missing: "Say why this category was chosen.",
  decider_missing: "Say who decided the category.",
  effective_in_future: "A category applies from today or an earlier date.",
  kind_mismatch:
    "A first category supersedes nothing; a review or a correction supersedes the current one.",
  initial_exists: "This person already has a category. Record a review or a correction instead.",
  nothing_to_supersede: "This person has no category yet. Record their first category.",
  not_current:
    "Someone has recorded this person's category since you loaded it. Reload it and try again.",
  review_before_previous: "A review applies from the date of the category it replaces or later.",
  correction_date_changed:
    "A correction applies from the same date as the category it corrects. Record a review to change the date.",
};

export interface DependencyContext {
  /** The version in force now of the scale at the person's location, or null. */
  readonly version: ScaleVersionRecord | null;
  /** The person's records so far. */
  readonly records: readonly DependencyRecord[];
  /** Today's UK date. */
  readonly today: string;
}

/** Every problem with a new record (rule 6); an empty list means it may be stored. */
export function checkDependencyRecord(
  input: NewDependencyRecord,
  context: DependencyContext,
): DependencyProblem[] {
  const problems = new Set<DependencyProblem>();
  const definition = context.version?.definition;
  if (!definition || context.version?.state !== "approved") problems.add("no_scale");
  else {
    if (!definition.categories.some((c) => c.key === input.categoryKey)) {
      problems.add("category_unknown");
    }
    const periods = new Set(definition.periods.map((p) => p.key));
    const seen = new Set<string>();
    for (const entry of input.oneToOne) {
      if (!periods.has(entry.periodKey)) problems.add("one_to_one_unknown_period");
      else if (seen.has(entry.periodKey)) problems.add("one_to_one_duplicate_period");
      seen.add(entry.periodKey);
      if (!wholeAtLeast(entry.minutes, 1)) problems.add("one_to_one_invalid");
    }
  }
  if (input.reason.trim() === "") problems.add("reason_missing");
  if (!input.decidedBy) problems.add("decider_missing");
  if (input.effectiveFrom > context.today) problems.add("effective_in_future");

  const head = currentDependency(context.records);
  if ((input.kind === "initial") !== (input.supersedesId === null)) problems.add("kind_mismatch");
  else if (input.kind === "initial") {
    if (head) problems.add("initial_exists");
  } else if (!head) problems.add("nothing_to_supersede");
  else if (input.supersedesId !== head.id) problems.add("not_current");
  else if (input.kind === "review" && input.effectiveFrom < head.effectiveFrom) {
    problems.add("review_before_previous");
  } else if (input.kind === "correction" && input.effectiveFrom !== head.effectiveFrom) {
    problems.add("correction_date_changed");
  }
  return [...problems];
}

// ---------------------------------------------------------------------------------------------
// Rules 9, 10 and 12: required care hours for a location and shift
// ---------------------------------------------------------------------------------------------

export interface RequirementPerson {
  readonly personId: string;
  /** False when on leave or in hospital: listed, not counted (rule 10). */
  readonly present: boolean;
  readonly records: readonly DependencyRecord[];
}

export interface ScaleWithVersions {
  readonly scaleId: string;
  readonly name: string;
  readonly versions: readonly ScaleVersionRecord[];
}

export interface RequirementInput {
  readonly locationId: string;
  /** The UK date. */
  readonly date: string;
  /** One period only, by key; every period of the date when absent. */
  readonly periodKey?: string | null;
  readonly scale: ScaleWithVersions | null;
  readonly people: readonly RequirementPerson[];
}

/** Whether a person's record could be used on the period. */
export type PersonStanding = "assessed" | "not_assessed" | "other_scale" | "not_in_scale_version";
export type PersonFlag = "earlier_version" | "review_overdue";

export interface RequirementPersonLine {
  readonly personId: string;
  readonly present: boolean;
  readonly standing: PersonStanding;
  readonly recordId: string | null;
  readonly categoryKey: string | null;
  readonly categoryLabel: string | null;
  readonly careMinutes: number;
  readonly oneToOneMinutes: number;
  readonly flags: readonly PersonFlag[];
}

export interface CategoryLine {
  readonly key: string;
  readonly label: string;
  readonly minutesEach: number;
  /** Present people counted in this category. */
  readonly people: number;
  readonly minutes: number;
}

export type RequirementWarningCode =
  | "no_scale"
  | "not_assessed"
  | "other_scale"
  | "not_in_scale_version"
  | "earlier_version"
  | "review_overdue"
  | "people_away";

export interface RequirementWarning {
  readonly code: RequirementWarningCode;
  readonly message: string;
  readonly personIds: readonly string[];
}

/** Where the figure comes from: the organisation's own scale, never Harbour (rule 12). */
export interface RequirementSource {
  readonly kind: "organisation_scale";
  readonly scaleId: string;
  readonly scaleName: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
}

export interface PeriodRequirement {
  readonly status: "computed";
  readonly locationId: string;
  readonly date: string;
  readonly period: PeriodWindow;
  readonly source: RequirementSource;
  readonly notice: string;
  /** Present people's category minutes for the period. */
  readonly careMinutes: number;
  /** Present people's one-to-one minutes for the period. */
  readonly oneToOneMinutes: number;
  readonly requiredMinutes: number;
  /** What people on leave or in hospital would add (not in `requiredMinutes`). */
  readonly awayMinutes: number;
  readonly categories: readonly CategoryLine[];
  readonly oneToOne: readonly { readonly personId: string; readonly minutes: number }[];
  readonly people: readonly RequirementPersonLine[];
  readonly skillMix: readonly { readonly skill: StaffingSkill; readonly minimumStaff: number }[];
  /** False when a present person is not counted: the required hours are a lower bound. */
  readonly complete: boolean;
  readonly warnings: readonly RequirementWarning[];
  readonly method: readonly string[];
}

export interface NoScaleRequirement {
  readonly status: "no_scale";
  readonly locationId: string;
  readonly date: string;
  /** The period, when a later version shows it existed; null when there is no version at all. */
  readonly period: PeriodWindow | null;
  readonly notice: string;
  readonly warnings: readonly RequirementWarning[];
}

export type StaffingRequirement = PeriodRequirement | NoScaleRequirement;

/** "4 hours 30 minutes", "1 hour", "45 minutes". */
export function formatCareMinutes(total: number): string {
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const minutes = Math.round(total - hours * MINUTES_PER_HOUR);
  const h = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const m = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (minutes === 0) return h;
  return hours === 0 ? m : `${h} ${m}`;
}

const peopleWord = (n: number) => (n === 1 ? "1 person" : `${n} people`);
const isAre = (n: number) => (n === 1 ? "is" : "are");

const NO_SCALE_WARNING: RequirementWarning = {
  code: "no_scale",
  message:
    "No dependency scale is in force for this location at this time, so no required care hours can be shown. Your organisation approves its scale first.",
  personIds: [],
};

/** Each period of the date with the version in force at its start (rule 3), or null before any. */
function periodsOfDate(
  versions: readonly ScaleVersionRecord[],
  date: string,
): { window: PeriodWindow; version: ScaleVersionRecord | null }[] {
  const dayStart = ukStartOfDay(date);
  const dayEnd = ukStartOfDay(plusDays(date, 1));
  const atStart = scaleVersionInForce(versions, dayStart);
  const during = versions
    .filter(
      (v): v is ScaleVersionRecord & { approvedAt: Date } =>
        (v.state === "approved" || v.state === "superseded") &&
        v.approvedAt !== null &&
        v.approvedAt > dayStart &&
        v.approvedAt < dayEnd,
    )
    .sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime());
  const relevant = [...(atStart ? [atStart] : []), ...during];
  const out: { window: PeriodWindow; version: ScaleVersionRecord | null }[] = [];
  relevant.forEach((version, i) => {
    const from = version.approvedAt as Date;
    const to = relevant[i + 1]?.approvedAt ?? null;
    for (const window of periodWindows(version.definition.periods, date)) {
      if (window.start >= from && (to === null || window.start < to)) {
        out.push({ window, version });
      } else if (i === 0 && !atStart && window.start < from) {
        // Before the first approval: the period existed, but no scale was in force at its start.
        out.push({ window, version: null });
      }
    }
  });
  return out.sort((a, b) => a.window.start.getTime() - b.window.start.getTime());
}

function personLine(
  person: RequirementPerson,
  scaleId: string,
  version: ScaleVersionRecord,
  window: PeriodWindow,
): RequirementPersonLine {
  const empty = {
    personId: person.personId,
    present: person.present,
    careMinutes: 0,
    oneToOneMinutes: 0,
    flags: [] as PersonFlag[],
  };
  const record = dependencyInForce(person.records, window.start);
  if (!record) {
    return {
      ...empty,
      standing: "not_assessed",
      recordId: null,
      categoryKey: null,
      categoryLabel: null,
    };
  }
  const known = { recordId: record.id, categoryKey: record.categoryKey };
  if (record.scaleId !== scaleId) {
    return { ...empty, ...known, standing: "other_scale", categoryLabel: null };
  }
  const definition = version.definition;
  const category = definition.categories.find((c) => c.key === record.categoryKey);
  const periodKeys = new Set(definition.periods.map((p) => p.key));
  if (!category || record.oneToOne.some((e) => !periodKeys.has(e.periodKey))) {
    return { ...empty, ...known, standing: "not_in_scale_version", categoryLabel: null };
  }
  const flags: PersonFlag[] = [];
  if (record.scaleVersionId !== version.id) flags.push("earlier_version");
  const interval = definition.reviewIntervalDays;
  if (interval !== null && daysFrom(record.effectiveFrom, ukDateOf(window.start)) > interval) {
    flags.push("review_overdue");
  }
  return {
    ...empty,
    ...known,
    standing: "assessed",
    categoryLabel: category.label,
    careMinutes: category.careMinutes.find((e) => e.periodKey === window.key)?.minutes ?? 0,
    oneToOneMinutes: record.oneToOne
      .filter((e) => e.periodKey === window.key)
      .reduce((sum, e) => sum + e.minutes, 0),
    flags,
  };
}

function periodRequirement(
  input: RequirementInput,
  scale: ScaleWithVersions,
  version: ScaleVersionRecord,
  window: PeriodWindow,
): PeriodRequirement {
  const people = input.people.map((p) => personLine(p, scale.scaleId, version, window));
  const counted = people.filter((p) => p.present && p.standing === "assessed");
  const away = people.filter((p) => !p.present && p.standing === "assessed");
  const notCounted = people.filter((p) => p.present && p.standing !== "assessed");

  const categories: CategoryLine[] = version.definition.categories.map((c) => {
    const minutesEach = c.careMinutes.find((e) => e.periodKey === window.key)?.minutes ?? 0;
    const n = counted.filter((p) => p.categoryKey === c.key).length;
    return { key: c.key, label: c.label, minutesEach, people: n, minutes: n * minutesEach };
  });
  const careMinutes = categories.reduce((sum, c) => sum + c.minutes, 0);
  const oneToOne = counted
    .filter((p) => p.oneToOneMinutes > 0)
    .map((p) => ({ personId: p.personId, minutes: p.oneToOneMinutes }));
  const oneToOneMinutes = oneToOne.reduce((sum, o) => sum + o.minutes, 0);
  const requiredMinutes = careMinutes + oneToOneMinutes;
  const awayMinutes = away.reduce((sum, p) => sum + p.careMinutes + p.oneToOneMinutes, 0);

  const warnings: RequirementWarning[] = [];
  const warn = (code: RequirementWarningCode, lines: RequirementPersonLine[], message: string) => {
    if (lines.length > 0) {
      warnings.push({ code, message, personIds: lines.map((l) => l.personId) });
    }
  };
  const standing = (s: PersonStanding) => people.filter((p) => p.standing === s);
  const n = (lines: RequirementPersonLine[]) => lines.length;
  const notAssessed = standing("not_assessed");
  warn(
    "not_assessed",
    notAssessed,
    `${peopleWord(n(notAssessed))} ${isAre(n(notAssessed))} not counted: no dependency category is in force. Record their category.`,
  );
  const otherScale = standing("other_scale");
  warn(
    "other_scale",
    otherScale,
    `${peopleWord(n(otherScale))} ${isAre(n(otherScale))} not counted: their category is on another location's scale. Record their category on this location's scale.`,
  );
  const missing = standing("not_in_scale_version");
  warn(
    "not_in_scale_version",
    missing,
    `${peopleWord(n(missing))} ${isAre(n(missing))} not counted: the scale version in force no longer has their category or one-to-one period. Review their category.`,
  );
  const earlier = people.filter((p) => p.flags.includes("earlier_version"));
  warn(
    "earlier_version",
    earlier,
    `${peopleWord(n(earlier))} ${isAre(n(earlier))} counted by a category recorded on an earlier version of the scale. Review them against the version in force.`,
  );
  const overdue = people.filter((p) => p.flags.includes("review_overdue"));
  warn(
    "review_overdue",
    overdue,
    `${peopleWord(n(overdue))} ${n(overdue) === 1 ? "has" : "have"} a category older than your review interval of ${version.definition.reviewIntervalDays} days. Review them.`,
  );
  warn(
    "people_away",
    away,
    `${peopleWord(n(away))} on leave or in hospital ${isAre(n(away))} not counted. They would add ${formatCareMinutes(awayMinutes)}.`,
  );

  const source: RequirementSource = {
    kind: "organisation_scale",
    scaleId: scale.scaleId,
    scaleName: scale.name,
    versionId: version.id,
    versionNumber: version.versionNumber,
    approvedBy: version.approvedBy,
    approvedAt: version.approvedAt,
  };
  const method = [
    `Scale: ${scale.name}, version ${version.versionNumber}${version.approvedAt ? `, approved on ${formatUkDate(version.approvedAt)}` : ""}. This is your organisation's own scale.`,
    `Period: ${window.label}, ${formatUkDateTime(window.start)} to ${formatUkDateTime(window.end)} (${formatCareMinutes(window.minutes)}).`,
    ...categories
      .filter((c) => c.people > 0)
      .map(
        (c) =>
          `${c.label}: ${peopleWord(c.people)} × ${formatCareMinutes(c.minutesEach)} = ${formatCareMinutes(c.minutes)}.`,
      ),
    ...(oneToOne.length > 0
      ? [`One-to-one: ${formatCareMinutes(oneToOneMinutes)} for ${peopleWord(oneToOne.length)}.`]
      : []),
    `Required care hours = ${formatCareMinutes(careMinutes)} by category + ${formatCareMinutes(oneToOneMinutes)} one-to-one = ${formatCareMinutes(requiredMinutes)}.`,
    ...(away.length > 0
      ? [
          `Not counted: ${peopleWord(away.length)} on leave or in hospital, who would add ${formatCareMinutes(awayMinutes)}.`,
        ]
      : []),
    ...(notCounted.length > 0
      ? [
          `Not counted: ${peopleWord(notCounted.length)} with no usable category, so the required care hours may be higher than shown.`,
        ]
      : []),
  ];

  return {
    status: "computed",
    locationId: input.locationId,
    date: input.date,
    period: window,
    source,
    notice: DEPENDENCY_TOOL_NOTICE,
    careMinutes,
    oneToOneMinutes,
    requiredMinutes,
    awayMinutes,
    categories,
    oneToOne,
    people,
    skillMix: version.definition.skillMix
      .filter((s) => s.periodKey === window.key)
      .map((s) => ({ skill: s.skill, minimumStaff: s.minimumStaff })),
    complete: notCounted.length === 0,
    warnings,
    method,
  };
}

/**
 * Required care hours for a location on a UK date, per period (rules 9, 10 and 12): the
 * organisation's figures added up for the people at the location, with the method, the source
 * and the notice. With no scale in force the result says so and carries no figure, never 0.
 */
export function staffingRequirement(input: RequirementInput): StaffingRequirement[] {
  const noScale = (period: PeriodWindow | null): NoScaleRequirement => ({
    status: "no_scale",
    locationId: input.locationId,
    date: input.date,
    period,
    notice: DEPENDENCY_TOOL_NOTICE,
    warnings: [NO_SCALE_WARNING],
  });
  const scale = input.scale;
  if (!scale) return [noScale(null)];
  const periods = periodsOfDate(scale.versions, input.date).filter(
    (p) => !input.periodKey || p.window.key === input.periodKey,
  );
  if (periods.length === 0) return [noScale(null)];
  return periods.map(({ window, version }) =>
    version ? periodRequirement(input, scale, version, window) : noScale(window),
  );
}

// ---------------------------------------------------------------------------------------------
// Rule 11: comparison inputs for the rota (slice 21)
// ---------------------------------------------------------------------------------------------

export interface StaffingProvided {
  /** Care minutes the rota gives on the period. */
  readonly careMinutes: number;
  /** Rostered staff on the period holding each skill. */
  readonly staffWithSkill: Readonly<Partial<Record<StaffingSkill, number>>>;
}

export interface SkillGap {
  readonly skill: StaffingSkill;
  readonly label: string;
  readonly minimumStaff: number;
  readonly rostered: number;
  readonly short: number;
}

export interface StaffingComparison {
  readonly status: StaffingStatus;
  readonly word: string;
  readonly requiredMinutes: number | null;
  readonly providedMinutes: number;
  readonly shortMinutes: number;
  readonly skills: readonly SkillGap[];
  readonly source: RequirementSource | null;
  readonly notice: string;
  readonly warnings: readonly string[];
  readonly method: readonly string[];
}

/**
 * The rota against the requirement (rule 11): below when hours or a skill minimum fall short,
 * incomplete when nothing falls short but people are not counted, met only when complete and
 * nothing falls short. It advises; it never blocks a rota.
 */
export function compareStaffing(
  requirement: StaffingRequirement,
  provided: StaffingProvided,
): StaffingComparison {
  if (requirement.status === "no_scale") {
    return {
      status: "no_scale",
      word: STAFFING_STATUS_WORDS.no_scale,
      requiredMinutes: null,
      providedMinutes: provided.careMinutes,
      shortMinutes: 0,
      skills: [],
      source: null,
      notice: requirement.notice,
      warnings: requirement.warnings.map((w) => w.message),
      method: [],
    };
  }
  const shortMinutes = Math.max(0, requirement.requiredMinutes - provided.careMinutes);
  const skills: SkillGap[] = requirement.skillMix.map((s) => {
    const rostered = provided.staffWithSkill[s.skill] ?? 0;
    return {
      skill: s.skill,
      label: STAFFING_SKILL_LABELS[s.skill],
      minimumStaff: s.minimumStaff,
      rostered,
      short: Math.max(0, s.minimumStaff - rostered),
    };
  });
  const warnings: string[] = [];
  if (shortMinutes > 0) {
    warnings.push(
      `The rota gives ${formatCareMinutes(provided.careMinutes)} of care on ${requirement.period.label}; your scale requires ${formatCareMinutes(requirement.requiredMinutes)}, ${formatCareMinutes(shortMinutes)} short.`,
    );
  }
  for (const s of skills.filter((g) => g.short > 0)) {
    warnings.push(
      `Your scale requires at least ${s.minimumStaff} staff on ${requirement.period.label} with this skill: ${s.label}. The rota has ${s.rostered}.`,
    );
  }
  if (!requirement.complete) {
    warnings.push(
      "Some people are not counted, so the hours your scale requires may be higher than shown.",
    );
  }
  const below = shortMinutes > 0 || skills.some((s) => s.short > 0);
  const status: StaffingStatus = below ? "below" : requirement.complete ? "met" : "incomplete";
  return {
    status,
    word: STAFFING_STATUS_WORDS[status],
    requiredMinutes: requirement.requiredMinutes,
    providedMinutes: provided.careMinutes,
    shortMinutes,
    skills,
    source: requirement.source,
    notice: requirement.notice,
    warnings,
    method: [
      ...requirement.method,
      `Rota: ${formatCareMinutes(provided.careMinutes)} of care on ${requirement.period.label}.`,
    ],
  };
}

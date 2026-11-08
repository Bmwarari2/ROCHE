/**
 * Retention sweep rules (retention sweeps plan, section 5.2; docs/specs/retention.md). Pure
 * functions: they take the schedule rows, the facts about a record and the holds, and decide
 * whether the record is due for destruction. They never destroy anything: the sweep proposes and
 * a person approves (plan section 5.1).
 *
 * No period is written here. Periods come from `retention_class` rows; the age for the staff file
 * birthday (`retention.staff_file.birthday_age`) comes from the rate table and is passed in.
 *
 * Every answer the DPO has not yet confirmed is marked "provisional" with its human action.
 */

import { staffFileRetainUntil } from "../workforce/induction";
import type { StaffFileOption } from "./onboarding";
import {
  addPeriod,
  type HeldRecord,
  isUnderLegalHold,
  type LegalHoldView,
  type RetentionRule,
  type RetentionTrigger,
  retentionDecision,
  validateTenantOverride,
} from "./retention";

export const RETENTION_TRIGGERS = [
  "care_ended",
  "last_entry",
  "record_closed",
  "employment_ended_or_75th_birthday",
  "created",
  "tenant_policy",
] as const satisfies readonly RetentionTrigger[];

/** The class used by documents, casework and the catalogue for a staff file (not a schedule row). */
export const STAFF_FILE_CLASS = "staff_file";

/** retention.md: `staff_file.to_75th_birthday` is the default option. */
const DEFAULT_STAFF_FILE_OPTION: StaffFileOption = "staff_file.to_75th_birthday";

/** A `retention_class` row as stored: global (`tenantId` null) or the organisation's own. */
export interface RetentionClassRow {
  readonly tenantId: string | null;
  readonly recordClass: string;
  readonly period: number;
  readonly unit: string;
  readonly trigger: string;
}

/** What the sweep needs to know about the organisation. */
export interface RetentionTenant {
  readonly tenantId: string;
  /** The staff file option chosen at onboarding (provisional, H-1583); null until chosen. */
  readonly staffFileOption: StaffFileOption | null;
}

export interface ResolvedRule extends RetentionRule {
  /** The class the record asked for (`staff_file` resolves to the chosen row's class). */
  readonly requestedClass: string;
  /**
   * `tenant`: the organisation's row; `global`: the schedule's row; `unknown_class`: no row, so
   * the record is never destroyed (provisional, H-1585); `invalid_row`: the row's unit, trigger
   * or period cannot be read, so the record is never destroyed either.
   */
  readonly origin: "tenant" | "global" | "unknown_class" | "invalid_row";
}

function neverDestroyed(requestedClass: string, origin: ResolvedRule["origin"]): ResolvedRule {
  return {
    recordClass: requestedClass,
    requestedClass,
    period: 0,
    unit: "years",
    trigger: "tenant_policy",
    origin,
  };
}

function isTrigger(value: string): value is RetentionTrigger {
  return (RETENTION_TRIGGERS as readonly string[]).includes(value);
}

function toRule(row: RetentionClassRow): RetentionRule | null {
  if (row.unit !== "years" && row.unit !== "months") return null;
  if (!isTrigger(row.trigger)) return null;
  if (!Number.isInteger(row.period) || row.period < 0) return null;
  return { recordClass: row.recordClass, period: row.period, unit: row.unit, trigger: row.trigger };
}

/**
 * The rule for a record class: the organisation's row, else the global row. `staff_file` resolves
 * to the row the organisation's `staff_file_option` names (provisional, H-1583), the default
 * option until one is chosen. An unknown class resolves to `tenant_policy`, never destroyed
 * (provisional, H-1585). An organisation's row shorter than the schedule's is ignored: overrides
 * may only lengthen a period (validateTenantOverride).
 */
export function resolveRule(
  recordClass: string,
  rows: readonly RetentionClassRow[],
  tenant: RetentionTenant,
): ResolvedRule {
  const target =
    recordClass === STAFF_FILE_CLASS
      ? (tenant.staffFileOption ?? DEFAULT_STAFF_FILE_OPTION)
      : recordClass;
  const globalRow = rows.find((r) => r.tenantId === null && r.recordClass === target);
  const tenantRow = rows.find((r) => r.tenantId === tenant.tenantId && r.recordClass === target);
  if (!globalRow && !tenantRow) return neverDestroyed(recordClass, "unknown_class");

  const globalRule = globalRow ? toRule(globalRow) : null;
  const tenantRule = tenantRow ? toRule(tenantRow) : null;
  // A schedule row that cannot be read is never worked around with the organisation's row.
  if (globalRow && !globalRule) return neverDestroyed(recordClass, "invalid_row");
  if (
    tenantRule &&
    (globalRule === null ||
      globalRule.trigger === "tenant_policy" ||
      validateTenantOverride(globalRule, tenantRule).ok)
  ) {
    return { ...tenantRule, requestedClass: recordClass, origin: "tenant" };
  }
  if (globalRule) return { ...globalRule, requestedClass: recordClass, origin: "global" };
  return neverDestroyed(recordClass, "invalid_row");
}

/**
 * The facts a trigger is worked out from. The registry (plan section 5.3) reads them from the
 * record's own columns, or works them out where the record has none (provisional, H-1584), so
 * these are inputs, never table rows.
 */
export interface TriggerFacts {
  /** care_ended: the person died. */
  readonly diedAt?: Date | null;
  /** care_ended: the person's last placement or package ended. */
  readonly dischargedAt?: Date | null;
  /** care_ended: the person is receiving care now (for example readmitted after a discharge). */
  readonly receivingCare?: boolean;
  /** last_entry: the times of the entries on the register page or record. */
  readonly entryDates?: readonly Date[];
  /** record_closed: when the case, complaint, incident or agreement closed; null while open. */
  readonly closedAt?: Date | null;
  /** employment_ended_or_75th_birthday: the leaving date; null while still employed. */
  readonly employmentEndedAt?: Date | null;
  /** created: when the record was made. */
  readonly createdAt?: Date | null;
  /** created: the end of the pay reference period or financial year the record covers. */
  readonly periodEndsAt?: Date | null;
  /** created: the class counts from `periodEndsAt` (rota and timesheet, financial, payroll). */
  readonly countsFromPeriodEnd?: boolean;
}

function latest(dates: readonly (Date | null | undefined)[]): Date | null {
  let result: Date | null = null;
  for (const d of dates) if (d && (result === null || d.getTime() > result.getTime())) result = d;
  return result;
}

/**
 * The date a trigger fired, or null when it has not fired yet. For the staff file trigger this is
 * the leaving date; `dueDate` works out the keep-until date from it.
 */
export function triggerDate(trigger: RetentionTrigger, facts: TriggerFacts): Date | null {
  switch (trigger) {
    case "care_ended":
      if (facts.receivingCare) return null;
      return facts.diedAt ?? facts.dischargedAt ?? null;
    case "last_entry":
      return latest(facts.entryDates ?? []);
    case "record_closed":
      return facts.closedAt ?? null;
    case "employment_ended_or_75th_birthday":
      return facts.employmentEndedAt ?? null;
    case "created":
      if (facts.countsFromPeriodEnd) {
        // Never earlier than the record itself, and never from the creation date alone.
        return facts.periodEndsAt ? latest([facts.periodEndsAt, facts.createdAt]) : null;
      }
      return facts.createdAt ?? null;
    case "tenant_policy":
      return null;
  }
}

/** What the staff file rule needs beyond the leaving date. */
export interface StaffFileFacts {
  readonly dateOfBirth: Date | null;
  /** `retention.staff_file.birthday_age` from the rate table. */
  readonly birthdayAge: number;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const fromIsoDay = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * When a record of this rule becomes due: the trigger date plus the period, or for a staff file
 * the date `staffFileRetainUntil` works out (never before employment ends). Null when it cannot
 * be worked out: a `tenant_policy` class, or a staff file kept to the birthday with no date of
 * birth (H-874, kept for a person to decide).
 */
export function dueDate(rule: RetentionRule, trigger: Date, staff?: StaffFileFacts): Date | null {
  if (rule.trigger === "tenant_policy") return null;
  if (rule.trigger !== "employment_ended_or_75th_birthday") {
    return addPeriod(trigger, rule.period, rule.unit);
  }
  const afterLeaving = addPeriod(trigger, rule.period, rule.unit);
  if (rule.recordClass !== "staff_file.to_75th_birthday") return afterLeaving;
  if (!staff) return null;
  const until = staffFileRetainUntil({
    leftOn: isoDay(trigger),
    dateOfBirth: staff.dateOfBirth ? isoDay(staff.dateOfBirth) : null,
    choice: "staff_file.to_75th_birthday",
    afterLeaving: { period: rule.period, unit: rule.unit },
    birthdayAge: staff.birthdayAge,
  });
  if (until === null) return null;
  // An organisation that lengthens the row keeps the later of the birthday and the longer period.
  return latest([fromIsoDay(until), afterLeaving]);
}

/** One class a record belongs to, with its due date (null when none can be worked out yet). */
export interface ClassDue {
  readonly rule: ResolvedRule;
  readonly due: Date | null;
}

export type LongestWins =
  | { readonly kind: "tenant_policy"; readonly rule: ResolvedRule | null }
  | { readonly kind: "no_trigger_yet"; readonly rule: ResolvedRule }
  | { readonly kind: "due"; readonly due: Date; readonly rule: ResolvedRule };

/**
 * A record in more than one class is kept for the longest (retention.md): a `tenant_policy` class
 * keeps it indefinitely; a class whose trigger has not fired keeps it until it does; otherwise the
 * latest due date wins. A record in no class is never destroyed.
 */
export function longestWins(decisions: readonly ClassDue[]): LongestWins {
  const policy = decisions.find((d) => d.rule.trigger === "tenant_policy");
  if (policy) return { kind: "tenant_policy", rule: policy.rule };
  let best: { readonly due: Date; readonly rule: ResolvedRule } | null = null;
  for (const d of decisions) {
    if (d.due === null) return { kind: "no_trigger_yet", rule: d.rule };
    if (best === null || d.due.getTime() > best.due.getTime()) best = { due: d.due, rule: d.rule };
  }
  return best ? { kind: "due", ...best } : { kind: "tenant_policy", rule: null };
}

/**
 * A legal hold with the planned scopes (plan slice 12) added to today's person and record. A hold
 * names who (a person, a member of staff, an applicant or one record: any of them matches, as
 * today) and may narrow by record class, location and date range (every one it names must match).
 */
export interface RetentionHoldView extends LegalHoldView {
  readonly staffId?: string | null;
  readonly applicantId?: string | null;
  readonly recordClass?: string | null;
  readonly locationId?: string | null;
  /** Date range, inclusive at both ends; either end may be open. */
  readonly from?: Date | null;
  readonly to?: Date | null;
}

export const OPEN_CASE_KINDS = [
  "dsar_case",
  "complaint",
  "safeguarding_enquiry",
  "employee_relations_case",
] as const;
export type OpenCaseKind = (typeof OPEN_CASE_KINDS)[number];

/**
 * A case about someone. While open it holds its subject's records without anyone placing a hold
 * (provisional, H-1586).
 */
export interface OpenCaseView {
  readonly kind: OpenCaseKind;
  readonly personId?: string | null;
  readonly staffId?: string | null;
  readonly applicantId?: string | null;
  readonly closedAt: Date | null;
}

/** The record as the hold check sees it. */
export interface SweepHeldRecord extends HeldRecord {
  readonly staffId?: string | null;
  readonly applicantId?: string | null;
  readonly locationId?: string | null;
  /** The date the record is about (when it was made or happened), for date-range holds. */
  readonly occurredAt?: Date | null;
  readonly recordClasses: readonly string[];
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  a !== null && a !== undefined && a === b;

/** `staff_file` matches `staff_file.after_leaving`, and the reverse. */
function classMatches(holdClass: string, recordClass: string): boolean {
  return (
    holdClass === recordClass ||
    recordClass.startsWith(`${holdClass}.`) ||
    holdClass.startsWith(`${recordClass}.`)
  );
}

function namesWho(h: RetentionHoldView): boolean {
  return (
    h.personId !== null ||
    (h.subjectType !== null && h.subjectId !== null) ||
    Boolean(h.staffId) ||
    Boolean(h.applicantId)
  );
}

function hasNarrowing(h: RetentionHoldView): boolean {
  return Boolean(h.recordClass) || Boolean(h.locationId) || Boolean(h.from) || Boolean(h.to);
}

/**
 * True when the narrowing scopes a hold names all match. A record with no location or date
 * matches a hold that names one: a hold always wins, so doubt keeps the record.
 */
function narrowingMatches(record: SweepHeldRecord, h: RetentionHoldView): boolean {
  const holdClass = h.recordClass;
  if (holdClass && !record.recordClasses.some((c) => classMatches(holdClass, c))) return false;
  if (h.locationId && record.locationId && record.locationId !== h.locationId) return false;
  const at = record.occurredAt;
  if (at && h.from && at.getTime() < h.from.getTime()) return false;
  if (at && h.to && at.getTime() > h.to.getTime()) return false;
  return true;
}

function whoMatches(record: SweepHeldRecord, h: RetentionHoldView): boolean {
  return (
    isUnderLegalHold(record, [h]) ||
    same(h.staffId, record.staffId) ||
    same(h.applicantId, record.applicantId)
  );
}

/**
 * True when an unreleased legal hold, or an open case about the record's subject, covers the
 * record. Extends `isUnderLegalHold`: a hold that names only a person or a record behaves exactly
 * as it does there. A released hold and a closed case cover nothing.
 */
export function holdCovers(
  record: SweepHeldRecord,
  holds: readonly RetentionHoldView[],
  openCases: readonly OpenCaseView[] = [],
): boolean {
  const byHold = holds.some((h) => {
    if (h.releasedAt !== null) return false;
    const who = namesWho(h);
    const narrow = hasNarrowing(h);
    if (!who && !narrow) return false;
    if (who && !whoMatches(record, h)) return false;
    return narrow ? narrowingMatches(record, h) : true;
  });
  if (byHold) return true;
  return openCases.some(
    (c) =>
      c.closedAt === null &&
      (same(c.personId, record.personId) ||
        same(c.staffId, record.staffId) ||
        same(c.applicantId, record.applicantId)),
  );
}

/** A record offered to the sweep: what it is, who it is about, and the facts for its triggers. */
export interface SweepRecord extends SweepHeldRecord {
  readonly facts: TriggerFacts;
  /** For a staff file kept to the birthday. */
  readonly dateOfBirth?: Date | null;
}

export interface SweepRules {
  readonly rows: readonly RetentionClassRow[];
  readonly tenant: RetentionTenant;
  /** `retention.staff_file.birthday_age` from the rate table. */
  readonly staffFileBirthdayAge: number;
}

export interface SweepHolds {
  readonly legalHolds: readonly RetentionHoldView[];
  readonly openCases: readonly OpenCaseView[];
}

export type SweepDecision =
  | { readonly status: "held" }
  | { readonly status: "tenant_policy"; readonly rule: ResolvedRule | null }
  | { readonly status: "no_trigger_yet"; readonly rule: ResolvedRule }
  | { readonly status: "retain"; readonly until: Date; readonly rule: ResolvedRule }
  | { readonly status: "due"; readonly since: Date; readonly rule: ResolvedRule };

/**
 * Whether a record is due for destruction at `now`: `held` (a hold always wins), `tenant_policy`
 * (never offered until the organisation sets a period), `no_trigger_yet` (an open record, a person
 * in care, a member of staff still employed), `retain` (until the longest due date) or `due`
 * (since that date, with the rule that set it). A `due` record is only proposed: a person approves.
 */
export function sweepDecision(
  record: SweepRecord,
  rules: SweepRules,
  holds: SweepHolds,
  now: Date,
): SweepDecision {
  if (holdCovers(record, holds.legalHolds, holds.openCases)) return { status: "held" };
  const staff: StaffFileFacts = {
    dateOfBirth: record.dateOfBirth ?? null,
    birthdayAge: rules.staffFileBirthdayAge,
  };
  const dues = record.recordClasses.map((recordClass): ClassDue => {
    const rule = resolveRule(recordClass, rules.rows, rules.tenant);
    const fired = triggerDate(rule.trigger, record.facts);
    return { rule, due: fired ? dueDate(rule, fired, staff) : null };
  });
  const winner = longestWins(dues);
  if (winner.kind === "tenant_policy") return { status: "tenant_policy", rule: winner.rule };
  if (winner.kind === "no_trigger_yet") return { status: "no_trigger_yet", rule: winner.rule };
  // The due date already includes the period; retentionDecision compares it with now.
  const decision = retentionDecision(
    { ...winner.rule, period: 0 },
    { triggerDate: winner.due, legalHold: false },
    now,
  );
  if (decision.status === "retain") {
    return { status: "retain", until: decision.until, rule: winner.rule };
  }
  return { status: "due", since: winner.due, rule: winner.rule };
}

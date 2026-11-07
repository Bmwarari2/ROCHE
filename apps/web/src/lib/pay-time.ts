import type { Translator } from "@harbour/i18n";
import { formatDate } from "@/lib/format";
import type { SafetyChip } from "@/lib/incidents";
import { readDateField } from "@/lib/uk-time";

/**
 * Time, working time, absence and pay screens (Phase 2 slice 60; SCHED-003 to 007, SCHED-010;
 * scheduling.md sections 16 to 18). Gates, status chips (an icon and a word, never colour alone)
 * and form readers; the API checks every permission and rule again.
 */

export const SELF = "scheduling.timesheet.self";
export const ROTA_MANAGE = "scheduling.rota.manage";
export const ROTA_APPROVE = "scheduling.rota.approve";
export const PAY_MANAGE = "scheduling.pay.manage";
export const PAY_APPROVE = "scheduling.pay.approve";

export const myTimeShown = (p: readonly string[]) => p.includes(SELF);
export const timesheetsShown = (p: readonly string[]) =>
  p.includes(ROTA_APPROVE) || p.includes(ROTA_MANAGE);
export const absencesShown = (p: readonly string[]) =>
  p.includes(SELF) || p.includes(ROTA_MANAGE) || p.includes(ROTA_APPROVE);
export const payShown = (p: readonly string[]) => p.includes(PAY_MANAGE) || p.includes(PAY_APPROVE);

export const ABSENCE_REQUEST_KINDS = [
  "annual_leave",
  "compassionate",
  "carers_leave",
  "parental_leave",
] as const;
export const PAY_FREQUENCIES = ["weekly", "monthly"] as const;

/**
 * Statutory leave, never declined (H-970; `STATUTORY_LEAVE_KINDS` in packages/domain, and the
 * database's `absence_statutory` check): the absences screen never offers a decline for it.
 */
export const STATUTORY_LEAVE_KINDS = [
  "maternity",
  "paternity",
  "adoption",
  "parental_bereavement",
  "carers_leave",
  "parental_leave",
] as const;
/** Of those, the kinds an employer may postpone as the law allows (`POSTPONABLE_KINDS`). */
export const POSTPONABLE_KINDS = ["carers_leave", "parental_leave"] as const;

export type DecisionChoice = "approve" | "decline" | "postpone";

/**
 * The choices an approver has for a request (H-970): approve or decline ordinary leave; approve
 * or postpone carer's and parental leave while the law still allows a postponement
 * (`canPostpone`: the API gave the limits and the last day for notice has not passed); approve
 * only for other statutory leave.
 */
export function decisionOptions(kind: string, canPostpone: boolean): readonly DecisionChoice[] {
  if ((POSTPONABLE_KINDS as readonly string[]).includes(kind)) {
    return canPostpone ? ["approve", "postpone"] : ["approve"];
  }
  if ((STATUTORY_LEAVE_KINDS as readonly string[]).includes(kind)) return ["approve"];
  return ["approve", "decline"];
}

const chip = (
  status: SafetyChip["status"],
  icon: SafetyChip["icon"],
  label: string,
): SafetyChip => ({
  status,
  icon,
  label,
});

/** A timesheet entry: a draft to approve, approved, or corrected (struck through). */
export function timesheetChip(
  entry: { readonly status: string; readonly superseded: boolean },
  t: Translator,
): SafetyChip {
  if (entry.superseded) return chip("notApplicable", "circle-minus", t("payTime.entry.superseded"));
  if (entry.status === "approved") return chip("done", "circle-check", t("payTime.entry.approved"));
  if (entry.status === "draft") return chip("due", "file-pen", t("payTime.entry.draft"));
  return chip("overdue", "triangle-alert", t("payTime.entry.unknown"));
}

const ABSENCE: Record<string, Omit<SafetyChip, "label">> = {
  requested: { status: "due", icon: "clock" },
  approved: { status: "done", icon: "circle-check" },
  recorded: { status: "info", icon: "file-pen" },
  declined: { status: "notApplicable", icon: "circle-minus" },
  postponed: { status: "info", icon: "clock" },
  cancelled: { status: "notApplicable", icon: "circle-minus" },
};

/**
 * A read-only copy of an absence kept by the HR platform (integrations.md section 11.5 rule 2):
 * changed only there, so it is labelled "Managed in the HR platform" and offers no decision.
 */
export function fromHrPlatform(absence: { readonly source?: string | null }): boolean {
  return absence.source === "thapsus_hr";
}

/**
 * What the new pay run form says when sending a period set for the HR platform to the payroll
 * export instead was refused (HZ-140): a pay manager who does not approve pay is told who can;
 * a step-up is asked for in words that say to choose it again. Anything else as it came.
 */
export function confirmExportRefusal<R extends { ok: boolean; code?: string; message?: string }>(
  result: R,
  t: Translator,
): R {
  if (result.ok) return result;
  if (result.code === "missing_permission") {
    return { ...result, message: t("payTime.run.confirmExportNotAllowed") };
  }
  return result;
}

/** A pay run whose route to payroll is the HR platform (rule 12): its units go there by pay code. */
export function paidThroughHrPlatform(run: { readonly payRoute?: string | null }): boolean {
  return run.payRoute === "thapsus_hr";
}

export function absenceChip(state: string, t: Translator): SafetyChip {
  const known = ABSENCE[state];
  return known
    ? { ...known, label: t("payTime.absence.state", { state }) }
    : chip("overdue", "triangle-alert", t("payTime.absence.state", { state: "other" }));
}

/** HZ-123: shifts an absence leaves needing cover, said in words. */
export function coverChip(coverNeeded: number, t: Translator): SafetyChip | null {
  if (coverNeeded <= 0) return null;
  return chip(
    "overdue",
    "triangle-alert",
    t("payTime.absence.coverNeeded", { count: coverNeeded }),
  );
}

export function payRunChip(
  run: { readonly status: string; readonly openExceptions: number; readonly calculation: number },
  t: Translator,
): SafetyChip {
  if (run.status === "locked") return chip("done", "circle-check", t("payTime.run.locked"));
  if (run.calculation === 0) return chip("neutral", "file-pen", t("payTime.run.notCalculated"));
  if (run.openExceptions > 0) {
    return chip(
      "overdue",
      "triangle-alert",
      t("payTime.run.exceptions", { count: run.openExceptions }),
    );
  }
  return chip("due", "clock", t("payTime.run.readyToCheck"));
}

export function exceptionChip(status: string, t: Translator): SafetyChip {
  return status === "overridden"
    ? chip("done", "circle-check", t("payTime.exception.overridden"))
    : chip("overdue", "triangle-alert", t("payTime.exception.open"));
}

export function ruleSetChip(status: string, t: Translator): SafetyChip {
  return status === "approved"
    ? chip("done", "circle-check", t("payTime.ruleSet.approved"))
    : chip("due", "file-pen", t("payTime.ruleSet.draft"));
}

/** Whole pence as "£1,234.56" (never signed: a direction is said in words where it matters). */
export function pounds(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "";
  const abs = Math.abs(pence);
  return `£${Math.floor(abs / 100).toLocaleString("en-GB")}.${String(abs % 100).padStart(2, "0")}`;
}

/** A difference from the run corrected: "£2.50 more than ...", "£2.50 less than ...". */
export function difference(pence: number, t: Translator): string {
  const direction = pence > 0 ? "more" : pence < 0 ? "less" : "same";
  return t("payTime.line.difference", { direction, amount: pounds(pence) });
}

/** Minutes in whole words: "7 hours 30 minutes", "45 minutes", "0 minutes"; null "Not recorded". */
export function hoursAndMinutes(minutes: number | null | undefined, t: Translator): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return t("payTime.notRecorded");
  }
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return t("payTime.duration", {
    hours,
    minutes: rest,
    both: hours > 0 && rest > 0 ? "yes" : "no",
    none: total === 0 ? "yes" : "no",
  });
}

type Read<T> =
  | { readonly ok: true; readonly body: T }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** A date from its day, month and year boxes, noting any error and the boxes it is about. */
function dateOf(
  form: FormData,
  name: string,
  subject: string,
  t: Translator,
  errors: Record<string, string>,
  parts: Record<string, readonly string[]>,
): string {
  const read = readDateField(form, name, { subject, t });
  if (read.ok) return read.date ?? "";
  errors[name] = read.message;
  if (read.parts) parts[name] = read.parts;
  return "";
}

function failed<T>(
  errors: Record<string, string>,
  parts: Record<string, readonly string[]>,
): Read<T> {
  return { ok: false, errors, ...(Object.keys(parts).length > 0 ? { parts } : {}) };
}

/** Asking for leave: a kind and the first and last days. */
export function readLeaveRequest(
  form: FormData,
  t: Translator,
  locationId: string,
): Read<{
  locationId: string;
  kind: string;
  startsOn: string;
  endsOn: string;
  selfCertified: boolean;
}> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const kind = text(form, "kind");
  if (!(ABSENCE_REQUEST_KINDS as readonly string[]).includes(kind)) {
    errors.kind = t("payTime.absence.form.kindError");
  }
  const startsOn = dateOf(
    form,
    "startsOn",
    t("payTime.absence.form.startSubject"),
    t,
    errors,
    parts,
  );
  const endsOn = dateOf(form, "endsOn", t("payTime.absence.form.endSubject"), t, errors, parts);
  if (startsOn && endsOn && endsOn < startsOn) errors.endsOn = t("payTime.absence.form.orderError");
  if (Object.keys(errors).length > 0) return failed(errors, parts);
  return { ok: true, body: { locationId, kind, startsOn, endsOn, selfCertified: false } };
}

/** The request a decision is about, for the statutory choices (H-970). */
export interface DecisionRequest {
  readonly kind: string;
  readonly startsOn: string;
  readonly endsOn: string | null;
  /** The latest new first day a postponement may have, from the API (the rate table). */
  readonly latestStartsOn: string | null;
  /** Whether a postponement is still allowed today. */
  readonly canPostpone: boolean;
}

export type DecisionBody = {
  version: number;
  decision: DecisionChoice;
  reason?: string;
  startsOn?: string;
  endsOn?: string;
  confirmsPostponable?: boolean;
};

const DAY_MS = 86_400_000;
const calendarDays = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);

/**
 * A decision on a request: approve, decline with a reason, or postpone carer's or parental leave
 * with a reason and new dates of the same length, after the first day asked for and no later than
 * the latest day the API gave (H-970). The API checks every limit again, with the notice period.
 */
export function readDecision(
  form: FormData,
  t: Translator,
  version: number,
  request?: DecisionRequest,
): Read<DecisionBody> {
  const options = request
    ? decisionOptions(request.kind, request.canPostpone)
    : decisionOptions("annual_leave", false);
  const decision = text(form, "decision");
  const reason = text(form, "reason");
  if (!(options as readonly string[]).includes(decision)) {
    const key = options.includes("postpone")
      ? "payTime.absence.decide.choosePostpone"
      : options.includes("decline")
        ? "payTime.absence.decide.choose"
        : "payTime.absence.decide.chooseApprove";
    return { ok: false, errors: { decision: t(key) } };
  }
  const chosen = decision as DecisionChoice;
  if (chosen === "decline" && (reason.length < 3 || reason.length > 500)) {
    return { ok: false, errors: { reason: t("payTime.absence.decide.reasonError") } };
  }
  if (chosen !== "postpone" || !request) {
    return { ok: true, body: { version, decision: chosen, ...(reason ? { reason } : {}) } };
  }
  // Errors in the order the fields are on screen: new dates, confirmation, reason.
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const startsOn = dateOf(
    form,
    "newStartsOn",
    t("payTime.absence.decide.newStartSubject"),
    t,
    errors,
    parts,
  );
  const endsOn = dateOf(
    form,
    "newEndsOn",
    t("payTime.absence.decide.newEndSubject"),
    t,
    errors,
    parts,
  );
  if (startsOn && endsOn) {
    if (endsOn < startsOn) {
      errors.newEndsOn = t("payTime.absence.form.orderError");
    } else if (startsOn <= request.startsOn) {
      errors.newStartsOn = t("payTime.absence.decide.laterError");
    } else if (request.latestStartsOn && startsOn > request.latestStartsOn) {
      errors.newStartsOn = t("payTime.absence.decide.tooLateError", {
        latest: formatDate(request.latestStartsOn) ?? "",
      });
    } else if (
      request.endsOn &&
      calendarDays(startsOn, endsOn) !== calendarDays(request.startsOn, request.endsOn)
    ) {
      errors.newEndsOn = t("payTime.absence.decide.durationError", {
        count: calendarDays(request.startsOn, request.endsOn) + 1,
      });
    }
  }
  const confirmed = form.get("confirmsPostponable") !== null;
  if (request.kind === "parental_leave" && !confirmed) {
    errors.confirmsPostponable = t("payTime.absence.decide.confirmError");
  }
  if (reason.length < 3 || reason.length > 500) {
    errors.reason = t("payTime.absence.decide.postponeReasonError");
  }
  if (Object.keys(errors).length > 0) return failed(errors, parts);
  return {
    ok: true,
    body: {
      version,
      decision: "postpone",
      reason,
      startsOn,
      endsOn,
      ...(request.kind === "parental_leave" ? { confirmsPostponable: true } : {}),
    },
  };
}

/** A reason to override a pay run exception (3 to 500 characters). */
export function readOverride(
  form: FormData,
  t: Translator,
  version: number,
): Read<{ version: number; reason: string }> {
  const reason = text(form, "reason");
  if (reason.length < 3 || reason.length > 500) {
    return { ok: false, errors: { reason: t("payTime.exception.reasonError") } };
  }
  return { ok: true, body: { version, reason } };
}

/** A pay period: a week of seven days, or a month of 28 to 31. */
export function readPayRun(
  form: FormData,
  t: Translator,
): Read<{ frequency: "weekly" | "monthly"; periodStart: string; periodEnd: string }> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const frequency = text(form, "frequency");
  if (frequency !== "weekly" && frequency !== "monthly") {
    errors.frequency = t("payTime.run.form.frequencyError");
  }
  const periodStart = dateOf(
    form,
    "periodStart",
    t("payTime.run.form.startSubject"),
    t,
    errors,
    parts,
  );
  const periodEnd = dateOf(form, "periodEnd", t("payTime.run.form.endSubject"), t, errors, parts);
  if (periodStart && periodEnd && !errors.frequency) {
    const days = Math.round((Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000) + 1;
    const fits = frequency === "weekly" ? days === 7 : days >= 28 && days <= 31;
    if (!fits) errors.periodEnd = t("payTime.run.form.lengthError", { frequency });
  }
  if (Object.keys(errors).length > 0) return failed(errors, parts);
  return {
    ok: true,
    body: { frequency: frequency as "weekly" | "monthly", periodStart, periodEnd },
  };
}

/**
 * A draft rule set: a name, the day it applies from, and role rates as "role_key = pounds" one
 * per line, with the allowances in pounds. The organisation's own rates, never statutory ones.
 */
export function readRuleSet(
  form: FormData,
  t: Translator,
): Read<{
  name: string;
  effectiveFrom: string;
  roleRates: Record<string, number>;
  sleepInFlatPence: number;
  mileagePencePerMile: number;
}> {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const name = text(form, "name");
  if (name.length < 1 || name.length > 120) errors.name = t("payTime.ruleSet.form.nameError");
  const effectiveFrom = dateOf(
    form,
    "effectiveFrom",
    t("payTime.ruleSet.form.fromSubject"),
    t,
    errors,
    parts,
  );
  const roleRates: Record<string, number> = {};
  const lines = text(form, "roleRates")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const m = /^([a-z][a-z0-9_]{0,59})\s*=\s*£?(\d{1,5}(?:\.\d{1,2})?)$/.exec(line);
    if (!m) {
      errors.roleRates = t("payTime.ruleSet.form.ratesError");
      break;
    }
    roleRates[m[1] as string] = Math.round(Number(m[2]) * 100);
  }
  if (lines.length === 0) errors.roleRates = t("payTime.ruleSet.form.ratesError");
  const money = (field: string) => {
    const v = text(form, field);
    if (v === "") return 0;
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(v)) {
      errors[field] = t("payTime.ruleSet.form.moneyError");
      return 0;
    }
    return Math.round(Number(v) * 100);
  };
  const sleepInFlatPence = money("sleepIn");
  const mileagePencePerMile = money("mileage");
  if (Object.keys(errors).length > 0) return failed(errors, parts);
  return {
    ok: true,
    body: { name, effectiveFrom, roleRates, sleepInFlatPence, mileagePencePerMile },
  };
}

import type { Translator } from "@harbour/i18n";
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
  cancelled: { status: "notApplicable", icon: "circle-minus" },
};

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

/** Whole pence as "£1,234.56". */
export function pounds(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return "";
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100).toLocaleString("en-GB")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Minutes as "7 h 30 min". */
export function hoursAndMinutes(minutes: number, t: Translator): string {
  return t("payTime.duration", {
    hours: Math.floor(minutes / 60),
    minutes: Math.round(minutes % 60),
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

/** A decision on a request: approve, or decline with a reason. */
export function readDecision(
  form: FormData,
  t: Translator,
  version: number,
): Read<{ version: number; decision: "approve" | "decline"; reason?: string }> {
  const decision = text(form, "decision");
  const reason = text(form, "reason");
  if (decision !== "approve" && decision !== "decline") {
    return { ok: false, errors: { decision: t("payTime.absence.decide.choose") } };
  }
  if (decision === "decline" && (reason.length < 3 || reason.length > 500)) {
    return { ok: false, errors: { reason: t("payTime.absence.decide.reasonError") } };
  }
  return { ok: true, body: { version, decision, ...(reason ? { reason } : {}) } };
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

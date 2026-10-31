import type { QualityIndicatorOut } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { QualityChip } from "./evidence-packs";
import type { FormValues } from "./incident-forms";
import type { FieldErrors } from "./outcome";

/**
 * The quality dashboard and PIR screens (quality.md section 22; QUAL-005, QUAL-006; HZ-129). Pure
 * helpers: the months a reader may choose (whole months that have ended, up to 12), statuses as an
 * icon and a word, each figure in words (a withheld count is never 0), and the target form. The
 * API decides every rule again.
 */

export const DASHBOARD_PERMISSION = "quality.audit.manage";
export const dashboardShown = (permissions: readonly string[]) =>
  permissions.includes(DASHBOARD_PERMISSION);

/** The indicators Harbour counts today; the others show "No data" (quality.md section 22.1). */
export const BUILT_INDICATORS = [
  "falls",
  "pressure_ulcers",
  "medication_errors",
  "overdue_reviews",
  "incident_response",
] as const;

export const MAX_MONTHS = 12;
/** How many ended months the picker offers. */
export const MONTHS_OFFERED = 24;

type Indicator = QualityIndicatorOut;

export interface MonthOption {
  /** `YYYY-MM`. */
  readonly value: string;
  readonly first: string;
  readonly last: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function monthOf(value: string): MonthOption {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { value, first: `${value}-01`, last: `${value}-${pad(lastDay)}` };
}

/** The ended months, newest first, before the UK date `today`. */
export function endedMonths(today: string, count = MONTHS_OFFERED): MonthOption[] {
  let year = Number(today.slice(0, 4));
  let month = Number(today.slice(5, 7));
  const out: MonthOption[] = [];
  for (let i = 0; i < count; i += 1) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
    out.push(monthOf(`${year}-${pad(month)}`));
  }
  return out;
}

const monthIndex = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));

export type PeriodProblem = "order" | "tooLong" | "unknown";

/**
 * The period from the page's address (`from` and `to` as `YYYY-MM`): whole ended months, up to
 * 12. Last month when nothing is chosen; last month with the problem when the choice is unusable.
 */
export function readPeriod(
  params: { readonly from?: string | string[]; readonly to?: string | string[] },
  today: string,
): {
  readonly from: MonthOption;
  readonly to: MonthOption;
  readonly problem: PeriodProblem | null;
} {
  const months = endedMonths(today);
  const latest = months[0] as MonthOption;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const fromValue = one(params.from);
  const toValue = one(params.to);
  if (fromValue === undefined && toValue === undefined) {
    return { from: latest, to: latest, problem: null };
  }
  const from = months.find((m) => m.value === fromValue);
  const to = months.find((m) => m.value === toValue);
  if (!from || !to) return { from: latest, to: latest, problem: "unknown" };
  if (monthIndex(from.value) > monthIndex(to.value)) {
    return { from: latest, to: latest, problem: "order" };
  }
  if (monthIndex(to.value) - monthIndex(from.value) + 1 > MAX_MONTHS) {
    return { from: latest, to: latest, problem: "tooLong" };
  }
  return { from, to, problem: null };
}

export function monthLabel(value: string, t: Translator): string {
  return t("quality.dashboard.month", { month: value.slice(5, 7), year: value.slice(0, 4) });
}

/** RAG as an icon and a word, never colour alone. */
export function ragChip(status: Indicator["status"], t: Translator): QualityChip {
  const look = {
    green: { status: "done", icon: "circle-check" },
    amber: { status: "due", icon: "circle-alert" },
    red: { status: "overdue", icon: "triangle-alert" },
    no_data: { status: "neutral", icon: "circle-minus" },
  } as const;
  return { ...look[status], label: t("quality.dashboard.status", { status }) };
}

/** Whether an indicator is a rate per bed-days, a percentage or a count. */
export function valueKind(indicator: Pick<Indicator, "unit" | "multiplier">) {
  if (indicator.unit === "percent") return "percent" as const;
  if (indicator.multiplier > 1) return "bedDays" as const;
  return "count" as const;
}

/**
 * The figure in words: the value with its unit, "Withheld: fewer than N" for a small count
 * (never 0), or "No data".
 */
export function figureWords(indicator: Indicator, minGroupSize: number, t: Translator): string {
  if (indicator.display !== null) {
    return t("quality.dashboard.value", {
      kind: valueKind(indicator),
      value: indicator.display,
      multiplier: indicator.multiplier,
    });
  }
  if (indicator.reasonCode === "small_number") {
    return t("quality.dashboard.withheld", { min: minGroupSize });
  }
  return t("quality.dashboard.noData");
}

/** A count in the working: the number, or withheld (never 0 for a withheld count). */
export function countWords(
  count: number | null,
  indicator: Indicator,
  minGroupSize: number,
  t: Translator,
): string {
  if (count !== null) return count.toLocaleString("en-GB");
  if (indicator.reasonCode === "small_number") {
    return t("quality.dashboard.withheld", { min: minGroupSize });
  }
  return t("quality.dashboard.noData");
}

/** A target's direction in the words' terms. */
export const directionOf = (indicator: Pick<Indicator, "direction">) =>
  indicator.direction === "higher_is_better" ? ("higher" as const) : ("lower" as const);

/**
 * The target form: green and amber, numbers of 0 or more, percentages to 100, in the
 * indicator's direction. Every problem at once.
 */
export function readTarget(
  form: FormValues,
  indicator: {
    readonly direction: "lower_is_better" | "higher_is_better";
    readonly percent: boolean;
  },
  t: Translator,
):
  | { readonly ok: true; readonly green: number; readonly amber: number }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const errors: Record<string, string> = {};
  const number = (name: string) => {
    const text = String(form.get(name) ?? "").trim();
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) && value <= 1_000_000 ? value : null;
  };
  const green = number("green");
  const amber = number("amber");
  if (green === null) errors.green = t("quality.dashboard.targets.greenMissing");
  if (amber === null) errors.amber = t("quality.dashboard.targets.amberMissing");
  if (green !== null && amber !== null) {
    if (indicator.percent && (green > 100 || amber > 100)) {
      errors[green > 100 ? "green" : "amber"] = t("quality.dashboard.targets.percent");
    } else if (indicator.direction === "lower_is_better" ? green > amber : green < amber) {
      errors.green = t("quality.dashboard.targets.order", {
        direction: indicator.direction === "higher_is_better" ? "higher" : "lower",
      });
    }
  }
  if (Object.keys(errors).length > 0 || green === null || amber === null) {
    return { ok: false, errors };
  }
  return { ok: true, green, amber };
}

export const PIR_AREAS = ["safe", "effective", "caring", "responsive", "well-led"] as const;

/** A PIR answer in words: a number, a percentage, yes or no. */
export function pirAnswer(
  item: { readonly unit: string; readonly value: number | boolean | null },
  t: Translator,
): string | null {
  if (item.value === null) return null;
  if (typeof item.value === "boolean") {
    return t("quality.pir.answer", { kind: item.value ? "yes" : "no", value: 0 });
  }
  return t("quality.pir.answer", {
    kind: item.unit === "percent" ? "percent" : "count",
    value: item.value,
  });
}

export function pirChip(status: "prefilled" | "to_complete", t: Translator): QualityChip {
  return status === "prefilled"
    ? { status: "done", icon: "circle-check", label: t("quality.pir.status", { status }) }
    : { status: "due", icon: "pen-line", label: t("quality.pir.status", { status }) };
}

/**
 * The copy-friendly text: each prefilled figure on its own line, then the data points to
 * complete, in key question order.
 */
export function pirCopyText(
  items: readonly {
    readonly key: string;
    readonly status: "prefilled" | "to_complete";
    readonly unit: string;
    readonly value: number | boolean | null;
  }[],
  t: Translator,
): string {
  const label = (key: string) => t("quality.pir.label", { key });
  const prefilled = items
    .filter((i) => i.status === "prefilled")
    .map((i) => t("quality.pir.copyLine", { label: label(i.key), answer: pirAnswer(i, t) ?? "" }));
  const toComplete = items
    .filter((i) => i.status === "to_complete")
    .map((i) => t("quality.pir.copyToComplete", { label: label(i.key) }));
  return [...prefilled, ...toComplete].join("\n");
}

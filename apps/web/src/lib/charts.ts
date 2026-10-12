import type { FluidDay, ObservationItem } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { iddsiLabel } from "./care-record";

/**
 * Chart helpers (care.md rule 6). The web app never computes a NEWS2 score, a band or a fluid
 * shortfall: it reads what the API calculated and stored with the entry, and says it in words.
 */

export const CHARTS = [
  "fluid_intake",
  "fluid_output",
  "food",
  "repositioning",
  "bowel",
  "weight",
  "vitals",
] as const satisfies readonly ObservationItem["chart"][];
export type ChartKind = (typeof CHARTS)[number];

export function isChart(value: unknown): value is ChartKind {
  return typeof value === "string" && (CHARTS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------------------------------------
// NEWS2, as stored by the API in the entry's flags
// ------------------------------------------------------------------------------------------------

export interface ScoreWorking {
  readonly item: string;
  readonly value: string;
  readonly points: number;
}

export interface Workings {
  readonly rows: readonly ScoreWorking[];
  /** Rows the web app could not read: the screen says so rather than hiding them (HZ-014). */
  readonly unreadable: number;
}

export interface News2Flags {
  readonly toolVersion: string;
  readonly score: number;
  readonly band: string;
  readonly redScore: boolean;
  /** 1 or 2 as the API scored it; null when it did not say, so the screen says it is not known. */
  readonly spo2Scale: 1 | 2 | null;
  /** The RCP's wording (chart 2), for example "Medium". */
  readonly clinicalRisk: string;
  /** The RCP's wording, for example "Key threshold for urgent response". */
  readonly response: string;
  /** The RCP's wording (chart 4), for example "Minimum 1 hourly". */
  readonly monitoring: string;
  readonly workings: Workings;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Workings as the API returns them. A malformed row is never guessed at, and never dropped
 * silently: it is counted, so the screen can say some of the workings could not be shown.
 */
export function readWorkings(value: unknown): Workings {
  if (value === undefined || value === null) return { rows: [], unreadable: 0 };
  if (!Array.isArray(value)) return { rows: [], unreadable: 1 };
  const rows: ScoreWorking[] = [];
  let unreadable = 0;
  for (const row of value) {
    if (
      isRecord(row) &&
      typeof row.item === "string" &&
      typeof row.value === "string" &&
      typeof row.points === "number"
    ) {
      rows.push({ item: row.item, value: row.value, points: row.points });
    } else {
      unreadable += 1;
    }
  }
  return { rows, unreadable };
}

/** The NEWS2 result the API stored with a vital signs entry, or null when there is none. */
export function news2FromFlags(flags: Record<string, unknown>): News2Flags | null {
  const news2 = flags.news2;
  if (!isRecord(news2)) return null;
  const { score, band, clinicalRisk, response, monitoring } = news2;
  if (
    typeof score !== "number" ||
    typeof band !== "string" ||
    typeof clinicalRisk !== "string" ||
    typeof response !== "string"
  ) {
    return null;
  }
  return {
    toolVersion: typeof news2.toolVersion === "string" ? news2.toolVersion : "",
    score,
    band,
    redScore: news2.redScore === true,
    spo2Scale: news2.spo2Scale === 1 || news2.spo2Scale === 2 ? news2.spo2Scale : null,
    clinicalRisk,
    response,
    monitoring: typeof monitoring === "string" ? monitoring : "",
    workings: readWorkings(news2.workings),
  };
}

export type ChipStatus = "overdue" | "due" | "done" | "notApplicable" | "info" | "neutral";

/**
 * How strongly the NEWS2 band is shown. The word comes from the API (the RCP's clinical risk);
 * this only picks the chip, which always has an icon and the word.
 */
export function news2Chip(band: string): ChipStatus {
  switch (band) {
    case "high":
    case "medium":
      return "overdue";
    case "low_medium":
      return "due";
    default:
      return "neutral";
  }
}

/** The IDDSI comparison the API stored with a food or drink entry. */
export function iddsiOutcome(
  flags: Record<string, unknown>,
):
  | "match"
  | "mismatch"
  | "unsafe_mismatch"
  | "no_prescribed_level"
  | "level_not_recorded"
  | "prescribed_unreadable"
  | null {
  const iddsi = flags.iddsi;
  if (!isRecord(iddsi) || typeof iddsi.outcome !== "string") return null;
  const outcome = iddsi.outcome;
  return outcome === "match" ||
    outcome === "mismatch" ||
    outcome === "unsafe_mismatch" ||
    outcome === "no_prescribed_level" ||
    outcome === "level_not_recorded" ||
    outcome === "prescribed_unreadable"
    ? outcome
    : null;
}

/**
 * What the API flagged on a food or drink entry it kept from a device although the rules would
 * have refused it on the web form (HZ-016, clinical review C3): no level recorded, or a different
 * level with no reason. Null when there is nothing to say.
 */
export function iddsiProblem(
  flags: Record<string, unknown>,
): "level_not_recorded" | "reason_missing" | "prescribed_unreadable" | null {
  const problem = flags.iddsiProblem;
  return problem === "level_not_recorded" ||
    problem === "reason_missing" ||
    problem === "prescribed_unreadable"
    ? problem
    : null;
}

// ------------------------------------------------------------------------------------------------
// Fluid balance day
// ------------------------------------------------------------------------------------------------

export interface FluidDayView {
  /** The end of the meter: the target, or the intake when there is no target or it is passed. */
  readonly meterMax: number;
  readonly valueText: string;
  readonly status: ChipStatus;
  readonly statusText: string;
  readonly outputText: string;
  readonly entriesText: string;
}

/** The day as the API summed it: intake against the target, the shortfall so far, the output. */
export function fluidDayView(day: FluidDay, t: Translator): FluidDayView {
  const outputText = t("care.charts.fluid.output", { ml: day.outputMl });
  const entriesText = t("care.charts.fluid.entries", { count: day.entries });
  if (day.targetMl === null) {
    return {
      meterMax: Math.max(day.intakeMl, 1),
      valueText: t("care.charts.fluid.valueNoTarget", { intake: day.intakeMl }),
      status: "notApplicable",
      statusText: t("care.charts.fluid.noTarget"),
      outputText,
      entriesText,
    };
  }
  const short = day.shortfallMl !== null && day.shortfallMl > 0;
  return {
    meterMax: Math.max(day.targetMl, day.intakeMl, 1),
    valueText: t("care.charts.fluid.valueWithTarget", {
      intake: day.intakeMl,
      target: day.targetMl,
    }),
    status: short ? "due" : "done",
    statusText: short
      ? t("care.charts.fluid.shortfall", { ml: day.shortfallMl ?? 0 })
      : t("care.charts.fluid.targetReached"),
    outputText,
    entriesText,
  };
}

// ------------------------------------------------------------------------------------------------
// One line per chart entry
// ------------------------------------------------------------------------------------------------

const str = (value: unknown) => (typeof value === "string" ? value : null);
const num = (value: unknown) => (typeof value === "number" ? value : null);

/**
 * What was recorded, as a short list of facts in words ("250 ml", "Tea", "Refused") for lists and
 * the overview. Each item is a whole message; the screen separates them, never joins sentences.
 */
export function observationSummary(
  item: Pick<ObservationItem, "chart" | "values" | "flags">,
  t: Translator,
): string[] {
  const v = item.values;
  switch (item.chart) {
    case "fluid_intake": {
      const parts = [t("care.charts.ml", { ml: num(v.ml) ?? 0 })];
      const drink = str(v.drink);
      if (drink) parts.push(drink);
      const level = str(v.iddsiLevel);
      if (level) parts.push(iddsiLabel("drink", level, t));
      if (v.refused === true) parts.push(t("care.charts.refusedShort"));
      return parts;
    }
    case "fluid_output":
      return [
        t("care.charts.outputSummary", {
          ml: num(v.ml) ?? 0,
          kind: str(v.kind) ?? "other",
        }),
      ];
    case "food": {
      const parts = [
        t("care.charts.mealSummary", {
          meal: str(v.meal) ?? "other",
          portion: str(v.portion) ?? "other",
        }),
      ];
      const description = str(v.description);
      if (description) parts.push(description);
      const level = str(v.iddsiLevel);
      if (level) parts.push(iddsiLabel("food", level, t));
      if (v.refused === true) parts.push(t("care.charts.refusedShort"));
      return parts;
    }
    case "repositioning": {
      const parts = [t("care.charts.position", { position: str(v.position) ?? "other" })];
      parts.push(
        v.skinChecked === true ? t("care.charts.skinChecked") : t("care.charts.skinNotChecked"),
      );
      if (v.declined === true) parts.push(t("care.charts.declinedShort"));
      return parts;
    }
    case "bowel": {
      const type = num(v.bristolType);
      if (v.noMovement === true || type === null) return [t("care.charts.noBowelMovement")];
      const amount = str(v.amount);
      return [
        amount
          ? t("care.charts.bristolWithAmount", { type, amount })
          : t("care.charts.bristol", { type }),
      ];
    }
    case "weight":
      return [
        t("care.charts.weightSummary", {
          kg: num(v.kg) ?? 0,
          method: str(v.method) ?? "other",
        }),
      ];
    case "vitals": {
      // The readings as recorded; the NEWS2 result is shown on its own line from the flags.
      const rr = num(v.respirationRate);
      const spo2 = num(v.spo2);
      const systolic = num(v.systolic);
      const pulse = num(v.pulse);
      const temperature = num(v.temperature);
      const consciousness = str(v.consciousness);
      if (
        rr === null ||
        spo2 === null ||
        systolic === null ||
        pulse === null ||
        temperature === null ||
        consciousness === null
      ) {
        return [t("care.charts.entry")];
      }
      return [
        t("care.charts.vitalsReadings", {
          rr,
          spo2,
          oxygen: v.onOxygen === true ? "yes" : "no",
          systolic,
          pulse,
          consciousness,
          temperature,
        }),
      ];
    }
    default:
      return [t("care.charts.entry")];
  }
}

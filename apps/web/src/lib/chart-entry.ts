import type { ObservationValues } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { readNumber, readWholeNumber } from "./assessments";
import type { IDDSI_DRINK_LEVELS, IDDSI_FOOD_LEVELS } from "./care-record";
import type { ChartKind } from "./charts";
import { type ActionResult, type FieldErrors, fieldErrors } from "./outcome";
import type { FormLike } from "./uk-time";

/**
 * Reading a chart entry from its form (care.md rule 6; register row CARE-010). Each missing or
 * unreadable answer is said at its own field. Nothing is chosen for anyone: the NEWS2 air or
 * oxygen and consciousness questions start unanswered (HZ-012, HZ-014), and so does the IDDSI
 * texture given (HZ-016). The API checks the IDDSI levels and scores NEWS2 itself.
 */

/** The prescribed IDDSI levels, as far as the person viewing knows them. */
export interface Prescribed {
  readonly food: string | null;
  readonly drink: string | null;
}

export const OUTPUT_KINDS = ["urine", "vomit", "drain", "other"] as const;
export const MEALS = ["breakfast", "lunch", "dinner", "supper", "snack"] as const;
export const PORTIONS = ["none", "quarter", "half", "three_quarters", "all"] as const;
export const POSITIONS = ["left", "right", "back", "front", "sitting"] as const;
export const BRISTOL = [1, 2, 3, 4, 5, 6, 7] as const;
export const AMOUNTS = ["small", "medium", "large"] as const;
export const WEIGHT_METHODS = ["standing", "chair", "hoist", "bed"] as const;
export const CONSCIOUSNESS = ["alert", "new_confusion", "voice", "pain", "unresponsive"] as const;

export const CHART_FIELDS = [
  "ml",
  "drink",
  "iddsiLevel",
  "overrideReason",
  "kind",
  "meal",
  "portion",
  "description",
  "position",
  "bristolType",
  "amount",
  "kg",
  "method",
  "respirationRate",
  "spo2",
  "systolic",
  "pulse",
  "temperature",
  "oxygen",
  "consciousness",
  "occurredAt",
] as const;
export type ChartField = (typeof CHART_FIELDS)[number];

const text = (form: FormLike, name: string) => String(form.get(name) ?? "").trim();
const optional = (value: string) => (value ? value : undefined);

/** The amount in whole millilitres, 0 to 5,000, as the API accepts. */
function readMl(form: FormLike): number | null {
  const ml = readWholeNumber(form.get("ml"));
  return ml !== null && ml >= 0 && ml <= 5000 ? ml : null;
}

/** Each missing or unreadable field with the words to show at it, or null when none is. */
function problems(checks: readonly (readonly [ChartField, boolean, string])[]): FieldErrors | null {
  const errors: Record<string, string> = {};
  for (const [field, bad, message] of checks) if (bad) errors[field] = message;
  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Builds the chart entry from the form, or says what to fix at each field. Limits here are only
 * the shape the API accepts; it checks IDDSI levels (HZ-016) and scores vital signs with NEWS2
 * itself.
 */
export function readChartValues(
  chart: ChartKind,
  form: FormLike,
  t: Translator,
  prescribed: Prescribed,
): ObservationValues | ActionResult<never> {
  switch (chart) {
    case "fluid_intake": {
      const ml = readMl(form);
      const level = text(form, "iddsiLevel");
      // With a drink level prescribed, the level given must be recorded (HZ-016).
      const missing = problems([
        ["ml", ml === null, t("care.charts.amountRequired")],
        ["iddsiLevel", prescribed.drink !== null && !level, t("care.charts.drinkLevelRequired")],
      ]);
      if (missing || ml === null) return fieldErrors(missing ?? {});
      return {
        chart,
        ml,
        refused: form.get("refused") === "on",
        ...(optional(text(form, "drink")) ? { drink: text(form, "drink") } : {}),
        ...(level ? { iddsiLevel: level as (typeof IDDSI_DRINK_LEVELS)[number] } : {}),
        ...(optional(text(form, "overrideReason"))
          ? { overrideReason: text(form, "overrideReason") }
          : {}),
      };
    }
    case "fluid_output": {
      const ml = readMl(form);
      if (ml === null) return fieldErrors({ ml: t("care.charts.amountRequired") });
      return { chart, ml, kind: text(form, "kind") as (typeof OUTPUT_KINDS)[number] };
    }
    case "food": {
      const meal = text(form, "meal");
      const portion = text(form, "portion");
      const level = text(form, "iddsiLevel");
      const missing = problems([
        ["meal", !meal, t("care.charts.mealRequired")],
        ["portion", !portion, t("care.charts.portionRequired")],
        ["iddsiLevel", !level, t("care.charts.levelRequired")],
      ]);
      if (missing) return fieldErrors(missing);
      return {
        chart,
        meal: meal as (typeof MEALS)[number],
        portion: portion as (typeof PORTIONS)[number],
        iddsiLevel: level as (typeof IDDSI_FOOD_LEVELS)[number],
        refused: form.get("refused") === "on",
        ...(optional(text(form, "description")) ? { description: text(form, "description") } : {}),
        ...(optional(text(form, "overrideReason"))
          ? { overrideReason: text(form, "overrideReason") }
          : {}),
      };
    }
    case "repositioning": {
      const position = text(form, "position");
      if (!position) return fieldErrors({ position: t("care.charts.positionRequired") });
      return {
        chart,
        position: position as (typeof POSITIONS)[number],
        skinChecked: form.get("skinChecked") === "on",
        declined: form.get("declined") === "on",
      };
    }
    case "bowel": {
      const noMovement = form.get("noMovement") === "on";
      const type = readWholeNumber(form.get("bristolType"));
      if (!noMovement && type === null) {
        return fieldErrors({ bristolType: t("care.charts.bristolRequired") });
      }
      const amount = text(form, "amount");
      return {
        chart,
        bristolType: noMovement ? null : type,
        noMovement,
        ...(amount && !noMovement ? { amount: amount as (typeof AMOUNTS)[number] } : {}),
      };
    }
    case "weight": {
      const kg = readNumber(form.get("kg"));
      if (kg === null || kg < 20 || kg > 300) {
        return fieldErrors({ kg: t("care.charts.weightRequired") });
      }
      return { chart, kg, method: text(form, "method") as (typeof WEIGHT_METHODS)[number] };
    }
    case "vitals": {
      const respirationRate = readWholeNumber(form.get("respirationRate"));
      const spo2 = readWholeNumber(form.get("spo2"));
      const systolic = readWholeNumber(form.get("systolic"));
      const pulse = readWholeNumber(form.get("pulse"));
      const temperature = readNumber(form.get("temperature"));
      const oxygen = text(form, "oxygen");
      const consciousness = text(form, "consciousness");
      const reading = (name: ChartField) => t("care.charts.vitals.missing", { reading: name });
      const missing = problems([
        ["respirationRate", respirationRate === null, reading("respirationRate")],
        ["spo2", spo2 === null, reading("spo2")],
        ["systolic", systolic === null, reading("systolic")],
        ["pulse", pulse === null, reading("pulse")],
        ["temperature", temperature === null, reading("temperature")],
        ["oxygen", oxygen !== "air" && oxygen !== "oxygen", reading("oxygen")],
        [
          "consciousness",
          !(CONSCIOUSNESS as readonly string[]).includes(consciousness),
          reading("consciousness"),
        ],
      ]);
      if (
        missing ||
        respirationRate === null ||
        spo2 === null ||
        systolic === null ||
        pulse === null ||
        temperature === null
      ) {
        return fieldErrors(missing ?? {});
      }
      return {
        chart,
        respirationRate,
        spo2,
        onOxygen: oxygen === "oxygen",
        systolic,
        pulse,
        consciousness: consciousness as (typeof CONSCIOUSNESS)[number],
        temperature,
      };
    }
  }
}

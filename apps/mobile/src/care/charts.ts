/**
 * Recording charts offline (care.md section 4 rules 5 and 6; register CARE-010 and CARE-007).
 * Each chart turns what the carer entered into the API's typed chart values (`ObservationValues`
 * in `@harbour/contracts`), so the upload carries exactly what the server validates.
 *
 * - Food and drink: the IDDSI level given is compared with the person's prescribed level from
 *   their care profile, shown beside the choice; a different level is refused without a reason,
 *   and an unsafe one (food more solid, or a drink thinner, than prescribed) says the nurse in
 *   charge is alerted when it uploads (HZ-016). The rule is `checkIddsiEntry` from
 *   `@harbour/domain`, the one the API runs.
 * - Vital signs: NEWS2 is calculated on the device with `calculateNews2` from `@harbour/domain`,
 *   the server's calculator, on the SpO2 scale the person's record sets, so a raised score shows at
 *   once with no signal (HZ-012, HZ-014). Without the care profile on the device the scale is
 *   unknown, so no total is shown: it says so, and the server calculates it on upload (C6). The
 *   server recalculates every score on upload and raises the alert and tasks; the device shows the
 *   published banding and RCP chart 4 response, with the source, and the tenant's escalation policy.
 * - Food and drink: with no care profile on the device the prescribed levels are unknown, so a
 *   level is accepted only after the carer confirms they checked it; with a drink level prescribed
 *   a drink needs its level (C3).
 */
import type { ObservationValues } from "@harbour/contracts";
import {
  BRISTOL_STOOL_SCALE,
  calculateNews2,
  checkBowelEntry,
  checkIddsiEntry,
  describeIddsiLevel,
  IDDSI_DRINK_LEVELS,
  IDDSI_FOOD_LEVELS,
  type IddsiKind,
  type InputIssue,
  NEWS2_INPUT_LIMITS,
  type News2Consciousness,
  type News2Result,
} from "@harbour/domain";
import {
  type Correction,
  checkCorrectionReason,
  type EntryContext,
  type EntryRow,
  entryRow,
  type FieldError,
} from "./entries";
import { resolveOccurredAt, type WhenChoice } from "./time";

export type ChartKind = ObservationValues["chart"];

export const CHART_KINDS: readonly ChartKind[] = [
  "fluid_intake",
  "fluid_output",
  "food",
  "repositioning",
  "bowel",
  "weight",
  "vitals",
];

export function isChartKind(value: string): value is ChartKind {
  return (CHART_KINDS as readonly string[]).includes(value);
}

/** API limits from `@harbour/contracts` (`ObservationValues`); a test keeps them equal. */
export const CHART_LIMITS = {
  ml: { min: 0, max: 5000 },
  kg: { min: 20, max: 300, decimals: 1 },
  overrideReason: { max: 300 },
  drink: { max: 60 },
  foodDescription: { max: 200 },
} as const;

export const OUTPUT_KINDS = ["urine", "vomit", "drain", "other"] as const;
export const MEALS = ["breakfast", "lunch", "dinner", "supper", "snack"] as const;
export const PORTIONS = ["none", "quarter", "half", "three_quarters", "all"] as const;
export const POSITIONS = ["left", "right", "back", "front", "sitting"] as const;
export const BOWEL_AMOUNTS = ["small", "medium", "large"] as const;
export const WEIGH_METHODS = ["standing", "chair", "hoist", "bed"] as const;
export const CONSCIOUSNESS_LEVELS: readonly News2Consciousness[] = [
  "alert",
  "new_confusion",
  "voice",
  "pain",
  "unresponsive",
];
/** Bristol stool types 1 to 7, with the published descriptions. */
export const BRISTOL_TYPES = Object.keys(BRISTOL_STOOL_SCALE).map(Number);
export const IDDSI_FOOD_CODES = Object.keys(IDDSI_FOOD_LEVELS);
export const IDDSI_DRINK_CODES = Object.keys(IDDSI_DRINK_LEVELS);

/** The parts of `person_care_profile` charts read. */
export interface CareProfile {
  readonly iddsi_food_level: string | null;
  readonly iddsi_drink_level: string | null;
  readonly spo2_scale2: number | null;
}

/** What the chart form holds: typed text, single choices and yes or no answers. */
export interface ChartDraft {
  readonly chart: ChartKind;
  readonly text: Readonly<Record<string, string>>;
  readonly choice: Readonly<Record<string, string | null>>;
  readonly yesNo: Readonly<Record<string, boolean | null>>;
  readonly when: WhenChoice;
  readonly correction: Correction | null;
}

export type ChartErrors = Partial<Record<string, FieldError>>;

export type ChartCheck =
  | {
      readonly ok: true;
      readonly row: EntryRow;
      readonly values: ObservationValues;
      readonly news2: News2Result | null;
    }
  | { readonly ok: false; readonly errors: ChartErrors };

// Anchored at both ends; one optional fraction: no backtracking on what the user types.
const NUMBER = /^-?\d{1,6}(?:\.\d{1,6})?$/;

interface NumberRule {
  readonly min: number;
  readonly max: number;
  readonly decimals?: number;
}

/** Reads a typed number against limits; returns the number or the message to show. */
export function readNumber(raw: string | undefined, rule: NumberRule): number | FieldError {
  const value = (raw ?? "").trim();
  if (!value) return { key: "mobile.form.required" };
  if (!NUMBER.test(value)) return { key: "mobile.form.number" };
  const parsed = Number(value);
  const decimals = rule.decimals ?? 0;
  const fraction = value.includes(".") ? (value.split(".")[1]?.length ?? 0) : 0;
  if (decimals === 0 && fraction > 0) return { key: "mobile.form.wholeNumber" };
  if (fraction > decimals) return { key: "mobile.form.decimals", values: { decimals } };
  if (parsed < rule.min || parsed > rule.max) {
    return { key: "mobile.form.range", values: { min: rule.min, max: rule.max } };
  }
  return parsed;
}

function isError(value: unknown): value is FieldError {
  return typeof value === "object" && value !== null && "key" in value;
}

function optionalText(value: string | undefined, max: number): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function oneOf<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  errors: ChartErrors,
  field: string,
): T | undefined {
  if (value && (allowed as readonly string[]).includes(value)) return value as T;
  errors[field] = { key: value ? "mobile.form.choose" : "mobile.form.required" };
  return undefined;
}

function yesNo(
  value: boolean | null | undefined,
  errors: ChartErrors,
  field: string,
): boolean | undefined {
  if (value === true || value === false) return value;
  errors[field] = { key: "mobile.form.required" };
  return undefined;
}

/** The person's prescribed level beside the choice: "Level 5 Minced and moist (orange)". */
export function prescribedLevel(kind: IddsiKind, profile: CareProfile | null): string | null {
  const code = kind === "food" ? profile?.iddsi_food_level : profile?.iddsi_drink_level;
  if (!code) return null;
  try {
    return describeIddsiLevel(kind, code);
  } catch {
    return null;
  }
}

/**
 * HZ-016: the IDDSI rule the API runs, with the device's wording. Returns the flags to keep with
 * the entry, or the message for the level or the reason.
 */
export function checkIddsi(
  kind: IddsiKind,
  recorded: string,
  reason: string | undefined,
  profile: CareProfile | null,
):
  | { readonly ok: true; readonly flags: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly field: "iddsiLevel" | "overrideReason";
      readonly error: FieldError;
    } {
  const prescribed =
    (kind === "food" ? profile?.iddsi_food_level : profile?.iddsi_drink_level) ?? null;
  const check = checkIddsiEntry({ kind, prescribed, recorded, reason: reason ?? null });
  if (check.ok) {
    return { ok: true, flags: { iddsi: check.comparison, iddsiAlert: check.alertNurseInCharge } };
  }
  if (check.comparison === null) {
    return iddsiLevelKnown(kind, recorded)
      ? { ok: false, field: "iddsiLevel", error: { key: "mobile.iddsi.prescribedInvalid" } }
      : { ok: false, field: "iddsiLevel", error: { key: "mobile.iddsi.levelRequired" } };
  }
  const level = prescribed ? describeIddsiLevel(kind, prescribed) : "";
  return {
    ok: false,
    field: "overrideReason",
    error: {
      key:
        check.comparison.outcome === "unsafe_mismatch"
          ? "mobile.iddsi.unsafe"
          : "mobile.iddsi.mismatch",
      values: { level },
    },
  };
}

/**
 * C3: with no care profile on the device the prescribed levels are unknown ("Food and drink levels
 * not recorded"), so a level is accepted only once the carer confirms they checked it with the
 * nurse in charge. A profile with no level set means no level is prescribed, which is different.
 */
export function checkUnrecordedLevel(
  profile: CareProfile | null,
  draft: Pick<ChartDraft, "yesNo">,
): FieldError | null {
  if (profile) return null;
  return draft.yesNo.levelChecked === true ? null : { key: "mobile.iddsi.confirmUnrecorded" };
}

function iddsiLevelKnown(kind: IddsiKind, code: string): boolean {
  return (kind === "food" ? IDDSI_FOOD_CODES : IDDSI_DRINK_CODES).includes(code);
}

const NEWS2_FIELDS = [
  ["respirationRate", NEWS2_INPUT_LIMITS.respirationRate],
  ["spo2", NEWS2_INPUT_LIMITS.spo2],
  ["systolic", NEWS2_INPUT_LIMITS.systolicBp],
  ["pulse", NEWS2_INPUT_LIMITS.pulse],
  ["temperature", NEWS2_INPUT_LIMITS.temperature],
] as const;

export type News2Preview =
  | { readonly status: "incomplete" }
  | { readonly status: "invalid"; readonly errors: ChartErrors }
  /**
   * C6: every reading is there, but the person's SpO2 scale is not on this device (no care
   * profile, or the scale not recorded), so no total is calculated here; the server calculates it
   * on upload with the scale on the record.
   */
  | { readonly status: "noScale" }
  | { readonly status: "scored"; readonly result: News2Result };

/** True when the device knows which SpO2 scale the person's record sets. */
export function knowsSpo2Scale(profile: CareProfile | null): boolean {
  return profile !== null && (profile.spo2_scale2 === 0 || profile.spo2_scale2 === 1);
}

/** Reads the vital signs and scores NEWS2 as the carer types: incomplete until every reading. */
export function previewNews2(draft: ChartDraft, profile: CareProfile | null): News2Preview {
  const errors: ChartErrors = {};
  const readings: Record<string, number> = {};
  let missing = false;
  for (const [field, limits] of NEWS2_FIELDS) {
    const raw = (draft.text[field] ?? "").trim();
    if (!raw) {
      missing = true;
      continue;
    }
    const value = readNumber(raw, limits);
    if (isError(value)) errors[field] = value;
    else readings[field] = value;
  }
  const consciousness = draft.choice.consciousness;
  const onOxygen = draft.yesNo.onOxygen;
  if (!consciousness || onOxygen === null || onOxygen === undefined) missing = true;
  if (Object.keys(errors).length > 0) return { status: "invalid", errors };
  if (missing) return { status: "incomplete" };
  if (!knowsSpo2Scale(profile)) return { status: "noScale" };
  const outcome = calculateNews2({
    respirationRate: readings.respirationRate,
    spo2: readings.spo2,
    supplementalOxygen: onOxygen,
    systolicBp: readings.systolic,
    pulse: readings.pulse,
    consciousness: consciousness as News2Consciousness,
    temperature: readings.temperature,
    spo2Scale2Decision: profile?.spo2_scale2 === 1,
  });
  if (!outcome.ok) return { status: "invalid", errors: issuesToErrors(outcome.issues) };
  return { status: "scored", result: outcome.result };
}

const NEWS2_ITEM_FIELDS: Readonly<Record<string, string>> = {
  respirationRate: "respirationRate",
  spo2: "spo2",
  supplementalOxygen: "onOxygen",
  systolicBp: "systolic",
  pulse: "pulse",
  consciousness: "consciousness",
  temperature: "temperature",
};

function issuesToErrors(issues: readonly InputIssue[]): ChartErrors {
  const errors: ChartErrors = {};
  for (const issue of issues) {
    const field = NEWS2_ITEM_FIELDS[issue.item] ?? issue.item;
    errors[field] = {
      key:
        issue.problem === "missing"
          ? "mobile.form.required"
          : issue.problem === "not_allowed"
            ? "mobile.form.choose"
            : "mobile.form.number",
    };
  }
  return errors;
}

/** The NEWS2 flags kept with the entry, in the shape the API stores, so lists read both alike. */
export function news2Flags(result: News2Result): Record<string, unknown> {
  return { news2: { ...toStoredNews2(result), spo2Scale: result.spo2Scale } };
}

/** A calculated result in the stored shape, for display. */
export function toStoredNews2(result: News2Result): StoredNews2 {
  return {
    toolVersion: result.toolVersion,
    score: result.score,
    band: result.band,
    redScore: result.redScore,
    clinicalRisk: result.clinicalRisk,
    response: result.response,
    monitoring: result.monitoring.text,
    clinicalResponse: [...result.clinicalResponse],
    workings: result.workings,
  };
}

/** Validates a chart entry and builds its row, or returns a message per field. */
export function checkChart(
  draft: ChartDraft,
  profile: CareProfile | null,
  context: EntryContext,
  now: Date,
): ChartCheck {
  const errors: ChartErrors = {};
  const when = resolveOccurredAt(draft.when, now, context.windowDays);
  if (!when.ok) errors.when = { key: when.error };
  if (draft.correction) {
    const reason = checkCorrectionReason(draft.correction.reason);
    if (reason) errors.reason = reason;
  }

  let values: ObservationValues | undefined;
  let flags: Record<string, unknown> = {};
  let news2: News2Result | null = null;
  const text = draft.text;

  switch (draft.chart) {
    case "fluid_intake": {
      const ml = readNumber(text.ml, CHART_LIMITS.ml);
      if (isError(ml)) errors.ml = ml;
      const level = draft.choice.iddsiLevel ?? undefined;
      const reason = optionalText(text.overrideReason, CHART_LIMITS.overrideReason.max);
      // C3: with a drink level prescribed, a drink is recorded with the level given.
      if (!level && profile?.iddsi_drink_level) {
        errors.iddsiLevel = { key: "mobile.iddsi.levelRequired" };
      }
      if (level) {
        const unchecked = checkUnrecordedLevel(profile, draft);
        if (unchecked) errors.levelChecked = unchecked;
        const iddsi = checkIddsi("drink", level, reason, profile);
        if (iddsi.ok) flags = iddsi.flags;
        else errors[iddsi.field] = iddsi.error;
      }
      if (!isError(ml)) {
        values = {
          chart: "fluid_intake",
          ml,
          drink: optionalText(text.drink, CHART_LIMITS.drink.max),
          iddsiLevel: level as Extract<ObservationValues, { chart: "fluid_intake" }>["iddsiLevel"],
          overrideReason: reason,
          refused: draft.yesNo.refused === true,
        };
      }
      break;
    }
    case "fluid_output": {
      const ml = readNumber(text.ml, CHART_LIMITS.ml);
      if (isError(ml)) errors.ml = ml;
      const kind = oneOf(draft.choice.kind, OUTPUT_KINDS, errors, "kind");
      if (!isError(ml) && kind) values = { chart: "fluid_output", ml, kind };
      break;
    }
    case "food": {
      const meal = oneOf(draft.choice.meal, MEALS, errors, "meal");
      const portion = oneOf(draft.choice.portion, PORTIONS, errors, "portion");
      const level = draft.choice.iddsiLevel;
      const reason = optionalText(text.overrideReason, CHART_LIMITS.overrideReason.max);
      if (!level) errors.iddsiLevel = { key: "mobile.iddsi.levelRequired" };
      else {
        const unchecked = checkUnrecordedLevel(profile, draft);
        if (unchecked) errors.levelChecked = unchecked;
        const iddsi = checkIddsi("food", level, reason, profile);
        if (iddsi.ok) flags = iddsi.flags;
        else errors[iddsi.field] = iddsi.error;
      }
      if (meal && portion && level) {
        values = {
          chart: "food",
          meal,
          portion,
          iddsiLevel: level as Extract<ObservationValues, { chart: "food" }>["iddsiLevel"],
          overrideReason: reason,
          description: optionalText(text.description, CHART_LIMITS.foodDescription.max),
          refused: draft.yesNo.refused === true,
        };
      }
      break;
    }
    case "repositioning": {
      const position = oneOf(draft.choice.position, POSITIONS, errors, "position");
      const skinChecked = yesNo(draft.yesNo.skinChecked, errors, "skinChecked");
      if (position && skinChecked !== undefined) {
        values = {
          chart: "repositioning",
          position,
          skinChecked,
          declined: draft.yesNo.declined === true,
        };
      }
      break;
    }
    case "bowel": {
      const choice = draft.choice.bristolType;
      const noMovement = choice === "none";
      const type = noMovement || !choice ? null : Number(choice);
      if (!choice) errors.bristolType = { key: "mobile.form.required" };
      else if (!noMovement) {
        const check = checkBowelEntry({
          kind: "movement",
          occurredAt: now,
          bristolType: Number(type),
        });
        if (!check.ok) errors.bristolType = { key: "mobile.form.choose" };
      }
      const amount = draft.choice.amount
        ? oneOf(draft.choice.amount, BOWEL_AMOUNTS, errors, "amount")
        : undefined;
      if (choice && !errors.bristolType) {
        values = { chart: "bowel", bristolType: type, noMovement, amount };
      }
      break;
    }
    case "weight": {
      const kg = readNumber(text.kg, CHART_LIMITS.kg);
      if (isError(kg)) errors.kg = kg;
      const method = oneOf(draft.choice.method, WEIGH_METHODS, errors, "method");
      if (!isError(kg) && method) values = { chart: "weight", kg, method };
      break;
    }
    case "vitals": {
      const preview = previewNews2(draft, profile);
      if (preview.status === "invalid") Object.assign(errors, preview.errors);
      if (preview.status === "incomplete") {
        for (const [field] of NEWS2_FIELDS)
          if (!(text[field] ?? "").trim()) errors[field] = { key: "mobile.form.required" };
        if (!draft.choice.consciousness) errors.consciousness = { key: "mobile.form.required" };
        if (draft.yesNo.onOxygen === null || draft.yesNo.onOxygen === undefined) {
          errors.onOxygen = { key: "mobile.form.required" };
        }
      }
      if (preview.status === "scored" || preview.status === "noScale") {
        // With the scale unknown on the device, the readings go without a score (C6).
        if (preview.status === "scored") {
          news2 = preview.result;
          flags = news2Flags(preview.result);
        }
        values = {
          chart: "vitals",
          respirationRate: Number(text.respirationRate),
          spo2: Number(text.spo2),
          onOxygen: draft.yesNo.onOxygen === true,
          systolic: Number(text.systolic),
          pulse: Number(text.pulse),
          consciousness: draft.choice.consciousness as News2Consciousness,
          temperature: Number(text.temperature),
        };
      }
      break;
    }
  }

  if (Object.keys(errors).length > 0 || !values || !when.ok) return { ok: false, errors };
  return {
    ok: true,
    values,
    news2,
    row: {
      ...entryRow(context, when.occurredAt, now, draft.correction),
      chart: values.chart,
      chart_values: JSON.stringify(dropUndefined(values)),
      flags: JSON.stringify(flags),
    },
  };
}

function dropUndefined(values: ObservationValues): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
}

/** The NEWS2 result kept with an entry (device or server), or null. */
export interface StoredNews2 {
  readonly score: number;
  readonly band: string;
  readonly clinicalRisk: string;
  readonly response: string;
  readonly monitoring: string;
  readonly redScore: boolean;
  readonly toolVersion: string;
  /** RCP chart 4, word for word; empty for a result stored without it. */
  readonly clinicalResponse: readonly string[];
  readonly workings: ReadonlyArray<{ item: string; value: string; points: number }>;
}

export function readNews2(flagsJson: string | null | undefined): StoredNews2 | null {
  if (!flagsJson) return null;
  try {
    const parsed = JSON.parse(flagsJson) as { news2?: Partial<StoredNews2> };
    const n = parsed.news2;
    if (!n || typeof n.score !== "number" || typeof n.band !== "string") return null;
    return {
      score: n.score,
      band: n.band,
      clinicalRisk: typeof n.clinicalRisk === "string" ? n.clinicalRisk : "",
      response: typeof n.response === "string" ? n.response : "",
      monitoring: typeof n.monitoring === "string" ? n.monitoring : "",
      redScore: n.redScore === true,
      toolVersion: typeof n.toolVersion === "string" ? n.toolVersion : "",
      clinicalResponse: Array.isArray(n.clinicalResponse)
        ? n.clinicalResponse.filter((line): line is string => typeof line === "string")
        : [],
      workings: Array.isArray(n.workings) ? n.workings : [],
    };
  } catch {
    return null;
  }
}

/** How prominent a NEWS2 result is: icon plus words, never colour alone. */
export function news2Appearance(news2: Pick<StoredNews2, "score" | "band">): {
  readonly tone: "success" | "info" | "warning" | "danger";
  readonly icon: string;
  /** A raised score: anything above 0, which the published chart responds to. */
  readonly raised: boolean;
} {
  if (news2.band === "medium" || news2.band === "high") {
    return { tone: "danger", icon: "triangle-alert", raised: true };
  }
  if (news2.band === "low_medium") return { tone: "warning", icon: "triangle-alert", raised: true };
  if (news2.score > 0) return { tone: "info", icon: "circle-alert", raised: true };
  return { tone: "success", icon: "circle-check", raised: false };
}

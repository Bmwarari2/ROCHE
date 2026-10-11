import type { AssessmentItem, AssessmentToolKey } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDate } from "./format";

/**
 * Validated tools (care.md rule 5; register rows CARE-003 and CARE-006; hazards HZ-012 and
 * HZ-014). The API runs the published calculator and stores the result; the web app sends the
 * answers and shows the score, band, workings and follow-ups exactly as returned. It never scores.
 */

export const TOOL_KEYS = [
  "must",
  "ng249_falls",
  "waterlow",
  "braden",
] as const satisfies readonly AssessmentToolKey[];

/** The feature flag a tool waits on until its licence is confirmed (H-25), if any. */
export const TOOL_FLAGS: Readonly<Partial<Record<AssessmentToolKey, string>>> = {
  waterlow: "care.tool.waterlow",
  braden: "care.tool.braden",
};

export function isToolKey(value: unknown): value is AssessmentToolKey {
  return typeof value === "string" && (TOOL_KEYS as readonly string[]).includes(value);
}

/** The tools this organisation may run: MUST and falls always; Waterlow and Braden by flag. */
export function availableTools(flags: Readonly<Record<string, boolean>>): AssessmentToolKey[] {
  return TOOL_KEYS.filter((tool) => {
    const flag = TOOL_FLAGS[tool];
    return flag === undefined || flags[flag] === true;
  });
}

/** The latest result per tool, as `latest=true` returns them, keyed by tool. */
export function latestByTool(
  items: readonly AssessmentItem[],
): Partial<Record<AssessmentToolKey, AssessmentItem>> {
  const latest: Partial<Record<AssessmentToolKey, AssessmentItem>> = {};
  for (const item of items) {
    const current = latest[item.toolKey];
    if (!current || item.occurredAt > current.occurredAt) latest[item.toolKey] = item;
  }
  return latest;
}

/** The band in words, using the publisher's wording where the API returns it. */
export function bandLabel(
  item: Pick<AssessmentItem, "toolKey" | "band" | "details">,
  t: Translator,
): string | null {
  if (item.band === null) return null;
  switch (item.toolKey) {
    case "must":
      return t("care.assessments.band.must", { band: item.band });
    case "waterlow":
      return t("care.assessments.band.waterlow", { band: item.band });
    case "braden": {
      const label = item.details.bandLabel;
      return typeof label === "string" && label.trim()
        ? label
        : t("care.assessments.band.other", { band: item.band });
    }
    default:
      return t("care.assessments.band.other", { band: item.band });
  }
}

export type BandChip = "overdue" | "due" | "done" | "neutral";

/** How strongly a band is shown; the word always comes with it. */
export function bandChip(item: Pick<AssessmentItem, "band">): BandChip {
  switch (item.band) {
    case "high":
    case "high_risk":
    case "very_high_risk":
    case "severe_risk":
      return "overdue";
    case "medium":
    case "at_risk":
    case "moderate_risk":
      return "due";
    case "low":
    case "not_at_risk":
    case "below_at_risk_threshold":
      return "done";
    default:
      return "neutral";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A follow-up the result raised, in words. Reasons are the API's (the publisher's wording, for
 * example "MUST high risk: refer to dietitian or follow local policy"); anything unknown is left
 * out rather than guessed.
 */
export function triggerText(trigger: Record<string, unknown>, t: Translator): string | null {
  switch (trigger.kind) {
    case "task": {
      if (typeof trigger.reason !== "string") return null;
      return typeof trigger.forDays === "number"
        ? t("care.assessments.trigger.taskForDays", {
            reason: trigger.reason,
            days: trigger.forDays,
          })
        : t("care.assessments.trigger.task", { reason: trigger.reason });
    }
    case "urgent_alert":
      return typeof trigger.reason === "string"
        ? t("care.assessments.trigger.alert", { reason: trigger.reason })
        : null;
    case "rescreen":
      return typeof trigger.dueOn === "string" && typeof trigger.toolKey === "string"
        ? t("care.assessments.trigger.rescreen", {
            tool: trigger.toolKey,
            date: formatDate(trigger.dueOn) ?? trigger.dueOn,
          })
        : null;
    case "weight_interval": {
      const interval = trigger.interval;
      if (!isRecord(interval) || typeof interval.value !== "number") return null;
      return t("care.assessments.trigger.weight", {
        unit: interval.unit === "weeks" ? "weeks" : "months",
        value: interval.value,
      });
    }
    case "repeat_observations": {
      const frequency = trigger.frequency;
      return isRecord(frequency) && typeof frequency.text === "string"
        ? t("care.assessments.trigger.repeat", { frequency: frequency.text })
        : null;
    }
    default:
      return null;
  }
}

export function triggerTexts(item: Pick<AssessmentItem, "triggers">, t: Translator): string[] {
  return item.triggers.flatMap((trigger) => {
    const text = triggerText(trigger, t);
    return text ? [text] : [];
  });
}

/** NG249 falls: the recommendation and NICE's reason, as the API stored them. */
export function fallsDetails(item: Pick<AssessmentItem, "details">): {
  readonly recommendation: string | null;
  readonly reason: string | null;
} {
  const { recommendation, reason } = item.details;
  return {
    recommendation: typeof recommendation === "string" ? recommendation : null,
    reason: typeof reason === "string" ? reason : null,
  };
}

// ------------------------------------------------------------------------------------------------
// Reading form answers. Numbers are checked for shape only; the API applies the published limits.
// ------------------------------------------------------------------------------------------------

/** A decimal number typed in a form ("62.4", " 62,4 " is not accepted), or null. */
export function readNumber(value: FormDataEntryValue | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text.length > 12) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A whole number typed in a form, or null. */
export function readWholeNumber(value: FormDataEntryValue | null | undefined): number | null {
  const parsed = readNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

/** "yes" or "no" from a radio group, as a boolean; null when not answered. */
export function readYesNo(value: FormDataEntryValue | null | undefined): boolean | null {
  if (value === "yes") return true;
  if (value === "no") return false;
  return null;
}

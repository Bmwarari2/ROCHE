import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";

/**
 * The onboarding checklist page (PLAT-018; platform-completions.md rules 26 and 27): pure and
 * unit tested. Every item is the API's, worked out from the organisation's records; the page says
 * whether each is done as an icon and a word, and whether it blocks go-live in words too.
 */

export const ONBOARDING_PAGE = "/settings/onboarding";
/** The sample data section, where a step-up for removing sample data comes back to. */
export const SAMPLE_DATA_SECTION = `${ONBOARDING_PAGE}#sample-data`;
export const MANAGE = "platform.onboarding.manage";

export function onboardingShown(permissions: readonly string[]): boolean {
  return permissions.includes("platform.onboarding.read") || permissions.includes(MANAGE);
}

export function itemChip(
  item: { readonly done: boolean; readonly requiredForGoLive: boolean },
  t: Translator,
): SafetyChip {
  if (item.done)
    return {
      status: "done",
      icon: "circle-check",
      label: t("onboarding.itemState", { state: "done" }),
    };
  return item.requiredForGoLive
    ? {
        status: "overdue",
        icon: "triangle-alert",
        label: t("onboarding.itemState", { state: "blocks" }),
      }
    : { status: "due", icon: "clock", label: t("onboarding.itemState", { state: "todo" }) };
}

/** Which decision an outstanding entry of an item takes, if the page can record it. */
export type DecisionKind = "setting" | "retention" | "staff_file" | "dcb0160" | null;

export function decisionFor(itemKey: string): DecisionKind {
  switch (itemKey) {
    case "rates_reviewed":
    case "clinical_settings_reviewed":
      return "setting";
    case "retention_reviewed":
      return "retention";
    case "dcb0160_recorded":
      return "dcb0160";
    default:
      return null;
  }
}

export const STAFF_FILE_OPTIONS = [
  "staff_file.after_leaving",
  "staff_file.to_75th_birthday",
] as const;

/** Care and regulatory initialisms written in capitals, as staff know them. */
const INITIALISMS = new Set([
  "news2",
  "must",
  "iddsi",
  "dbs",
  "cqc",
  "nhs",
  "dols",
  "ico",
  "riddor",
  "prn",
  "la",
  "mar",
  "cd",
  "dpia",
  "ahra",
  "lgsco",
  "ukhsa",
  "spo2",
  "gp",
  "dcb0160",
  "cma",
]);

const UNITS: Readonly<Record<string, string>> = {
  working_days: "working days",
  days: "days",
  hours: "hours",
  minutes: "minutes",
  weeks: "weeks",
  months: "months",
  years: "years",
  ml: "ml",
};

/**
 * A rate key or record class in plain words for the checklist and its buttons, never the key itself
 * ("care_plan.review_interval_months" reads "Care plan review interval (months)"). Until each
 * setting has a name of its own in the catalogue, this keeps internal names off the screen.
 */
export function settingName(key: string): string {
  const words = key.replace(/\./g, " ").replace(/_/g, " ").trim();
  const unit = Object.keys(UNITS)
    .sort((a, b) => b.length - a.length)
    .find((u) => words.endsWith(` ${u.replace(/_/g, " ")}`));
  const base = unit ? words.slice(0, -(unit.length + 1)).trim() : words;
  const cased = base
    .split(" ")
    .map((word) => (INITIALISMS.has(word) ? word.toUpperCase() : word))
    .join(" ");
  const sentence = cased.charAt(0).toUpperCase() + cased.slice(1);
  return unit ? `${sentence} (${UNITS[unit]})` : sentence;
}

import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";

/**
 * The onboarding checklist page (PLAT-018; platform-completions.md rules 26 and 27): pure and
 * unit tested. Every item is the API's, worked out from the organisation's records; the page says
 * whether each is done as an icon and a word, and whether it blocks go-live in words too.
 */

export const ONBOARDING_PAGE = "/settings/onboarding";
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

import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  decisionFor,
  itemChip,
  onboardingShown,
  STAFF_FILE_OPTIONS,
  settingName,
} from "./onboarding";

describe("the onboarding checklist page", () => {
  it.each([
    [["platform.onboarding.read"], true],
    [["platform.onboarding.manage"], true],
    [["platform.dpia.read"], false],
  ] as const)("shows the page to %j: %s", (permissions, shown) => {
    expect(onboardingShown(permissions)).toBe(shown);
  });

  it.each([
    [true, true, "done", "Done"],
    [false, true, "overdue", "Not done: blocks go-live"],
    [false, false, "due", "Not done"],
  ])("says done %s (blocks go-live %s) as an icon and words", (done, required, status, label) => {
    expect(itemChip({ done, requiredForGoLive: required }, t)).toMatchObject({ status, label });
  });

  it.each([
    ["rates_reviewed", "setting"],
    ["clinical_settings_reviewed", "setting"],
    ["retention_reviewed", "retention"],
    ["dcb0160_recorded", "dcb0160"],
    ["dpia_signed", null],
    ["people_ready", null],
  ])("records the decisions %s needs here: %s", (key, kind) => {
    expect(decisionFor(key)).toBe(kind);
  });

  it("says each staff file option in words", () => {
    expect(
      STAFF_FILE_OPTIONS.map((option) =>
        t("onboarding.staffFile.option", { option: option.replace("staff_file.", "") }),
      ),
    ).toEqual(["For the set period after the person leaves", "Until the person's 75th birthday"]);
  });
});

describe("settings and record classes in words on the checklist", () => {
  it.each([
    ["care_plan.review_interval_months", "Care plan review interval (months)"],
    ["care_plan.initial_working_days", "Care plan initial (working days)"],
    ["downtime_pack", "Downtime pack"],
    ["news2.escalation_minutes", "NEWS2 escalation (minutes)"],
    ["la_review.interval_months", "LA review interval (months)"],
    ["serious_incident", "Serious incident"],
  ])("shows %s as %s, never the key", (key, words) => {
    expect(settingName(key)).toBe(words);
  });
});

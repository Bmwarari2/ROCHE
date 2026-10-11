import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { problemMessage, refused } from "./outcome";

const t = createTranslator("en-GB");

describe("problemMessage", () => {
  it("hazard HZ-019 shows the API's own words when it refuses an entry by rule", () => {
    const detail =
      "The mark is drawn on the person's left but the person's right was chosen. Check the side and try again.";
    expect(problemMessage({ code: "invalid", detail }, t)).toEqual({
      code: "invalid",
      message: detail,
    });
  });

  it("hides request validation messages that name fields by their path", () => {
    for (const detail of [
      "values.ml: Too small",
      "body: Invalid input",
      "answers.bmi.weightKg: x",
    ]) {
      expect(problemMessage({ code: "invalid", detail }, t).message).toBe(t("care.errors.invalid"));
    }
    expect(problemMessage({ code: "invalid" }, t).message).toBe(t("care.errors.invalid"));
    // A plain sentence with a colon is still shown.
    expect(
      problemMessage({ code: "invalid", detail: "Mobility: record the need." }, t).message,
    ).toBe("Mobility: record the need.");
  });

  it.each([
    ["version_conflict", "care.errors.conflict"],
    ["missing_permission", "errors.forbidden"],
    ["mfa_enrolment_required", "errors.forbidden"],
    ["step_up_required", "errors.stepUpRequired"],
    ["not_found", "errors.notFound"],
  ] as const)("maps %s to plain words", (code, key) => {
    expect(problemMessage({ code, detail: "ignored" }, t)).toEqual({ code, message: t(key) });
  });

  it("says the answers are kept when the API cannot be reached", () => {
    for (const error of [undefined, null, "text", { code: 42 }, { code: "internal" }]) {
      expect(problemMessage(error, t)).toEqual({
        code: "unavailable",
        message: t("care.errors.unavailable"),
      });
    }
  });

  it("passes on why a switched-off tool is refused", () => {
    expect(
      problemMessage({ code: "feature_disabled", detail: "Waterlow is off." }, t).message,
    ).toBe("Waterlow is off.");
    expect(problemMessage({ code: "feature_disabled" }, t).message).toBe(
      t("care.errors.featureDisabled"),
    );
    expect(refused("Write the note")).toEqual({
      ok: false,
      code: "invalid",
      message: "Write the note",
    });
  });
});

import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  collectedRefusal,
  errorFor,
  fieldErrors,
  outcomeUnknown,
  problemMessage,
  refused,
} from "./outcome";

const t = createTranslator("en-GB");

describe("problemMessage", () => {
  it.each([
    ["real_people_exist", "Sample data can only be loaded before you add real people."],
    ["already_loaded", "Sample data is already loaded."],
    ["nothing_to_remove", "There is no sample data to remove."],
    [
      "held",
      "A legal hold is in place on a sample person. Release the hold, then remove the sample data.",
    ],
    ["no_location", "Add a location before you load sample data."],
  ])("hazard HZ-072 says the sample data refusal %s in plain words", (code, message) => {
    expect(problemMessage({ code, detail: "ignored" }, t)).toEqual({ code, message });
  });

  it("hazard HZ-019 says a refusal by rule in the catalogue's words, tied to its fields", () => {
    const detail =
      "The mark is drawn on the person's left but the person's right was chosen. Check the side and try again.";
    const words = t("care.refusal.sideMismatch");
    expect(problemMessage({ code: "invalid", detail }, t)).toEqual({
      code: "invalid",
      message: words,
      fields: { side: words, region: words },
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
    ["already_saved_differently", "care.errors.alreadySavedDifferently"],
    ["missing_permission", "errors.forbidden"],
    ["mfa_enrolment_required", "errors.forbidden"],
    ["step_up_required", "errors.stepUpRequired"],
    ["mfa_verification_required", "errors.mfaVerifyRequired"],
    ["not_found", "errors.notFound"],
  ] as const)("maps %s to plain words", (code, key) => {
    expect(problemMessage({ code, detail: "ignored" }, t)).toEqual({ code, message: t(key) });
  });

  it("hazard HZ-029 says a save sent again with other details was not changed, never that someone else changed it", () => {
    const { message } = problemMessage(
      {
        code: "already_saved_differently",
        detail: "This was already saved with different details: reload before changing it.",
      },
      t,
    );
    expect(message).toBe(
      "This was already saved with different details, so your change was not saved. Reload the page, check what was saved, and enter your change again if it is still needed.",
    );
    expect(message).not.toContain("Someone else");
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

  it("ties a refusal the form finds to its fields, and reads a field's error back", () => {
    const result = refused("Write the note", "invalid", ["body"]);
    expect(result).toEqual({
      ok: false,
      code: "invalid",
      message: "Write the note",
      fields: { body: "Write the note" },
    });
    expect(errorFor(result, "body")).toBe("Write the note");
    expect(errorFor(result, "category")).toBeUndefined();
    expect(errorFor(null, "body")).toBeUndefined();
    expect(fieldErrors({ spo2: "Enter the SpO2", pulse: "Enter the pulse" })).toEqual({
      ok: false,
      code: "invalid",
      message: "Enter the SpO2",
      fields: { spo2: "Enter the SpO2", pulse: "Enter the pulse" },
    });
    expect(outcomeUnknown({ ok: false, code: "unavailable", message: "x" })).toBe(true);
    expect(outcomeUnknown(result)).toBe(false);
  });
});

describe("collectedRefusal", () => {
  it("lists every problem the form found, each at its field, with the boxes of a date", () => {
    const result = collectedRefusal([
      { field: "kind", message: "Choose what has stopped working" },
      { field: "startedAt", message: "Enter when it started", parts: ["day", "month"] },
    ]);
    expect(result).toEqual({
      ok: false,
      code: "invalid",
      message: "Choose what has stopped working",
      fields: { kind: "Choose what has stopped working", startedAt: "Enter when it started" },
      parts: { startedAt: ["day", "month"] },
    });
    expect(collectedRefusal([])).toBeNull();
  });
});

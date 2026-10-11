import { describe, expect, it } from "vitest";
import { answerFallsQuestion, NG249_FALLS_QUESTION_VERSION } from "./falls";

/** The NICE NG249 falls question: a trigger, never a score (medical-device boundary, section 4). */

function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
}

describe("NG249 falls question", () => {
  it.each([
    ["fallen in the past 12 months and presenting now", true, true],
    ["fallen in the past 12 months", true, false],
    ["presenting after a fall now", false, true],
    ["fallen, with the second question unanswered", true, null],
    ["presenting now, with the first question unanswered", null, true],
  ] as const)(
    "%s triggers the multifactorial falls assessment and a review",
    (_name, fallen, presenting) => {
      const outcome = answerFallsQuestion({
        fallenInPast12Months: fallen,
        presentingAfterFall: presenting,
      });
      expect(outcome).toMatchObject({
        ok: true,
        result: {
          toolKey: "ng249_falls_question",
          toolVersion: NG249_FALLS_QUESTION_VERSION,
          assessmentIndicated: true,
        },
      });
      const tasks = outcome.ok
        ? outcome.result.triggers.map((t) => t.kind === "task" && t.task)
        : [];
      expect(tasks).toEqual(["multifactorial_falls_assessment", "falls_review"]);
    },
  );

  it("gives the reason in words", () => {
    const outcome = answerFallsQuestion({ fallenInPast12Months: false, presentingAfterFall: true });
    expect(outcome.ok && outcome.result.triggers[0]).toMatchObject({
      reason: "Presenting after a fall (NICE NG249)",
    });
  });

  it("raises nothing when both answers are no", () => {
    expect(
      answerFallsQuestion({ fallenInPast12Months: false, presentingAfterFall: false }),
    ).toMatchObject({ ok: true, result: { assessmentIndicated: false, triggers: [] } });
  });

  it.each([
    [
      "one answer missing",
      { fallenInPast12Months: false },
      "Falls question incomplete: 1 answer missing.",
    ],
    ["both answers missing", {}, "Falls question incomplete: 2 answers missing."],
  ] as const)("does not conclude with %s", (_name, input, message) => {
    expect(answerFallsQuestion(input)).toMatchObject({ ok: false, code: "incomplete", message });
  });

  it("returns no numeric risk score, band or risk level of any kind (NICE NG249 1.1.1)", () => {
    for (const fallen of [true, false]) {
      const outcome = answerFallsQuestion({
        fallenInPast12Months: fallen,
        presentingAfterFall: false,
      });
      if (!outcome.ok) throw new Error(outcome.message);
      expect(numbersIn(outcome.result)).toEqual([]);
      expect(outcome.result).not.toHaveProperty("score");
      expect(outcome.result).not.toHaveProperty("band");
      expect(JSON.stringify(outcome.result)).not.toMatch(/risk/i);
    }
  });
});

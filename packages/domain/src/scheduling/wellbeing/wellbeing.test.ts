import { describe, expect, it } from "vitest";
import type { RateRow } from "../../platform/rates";
import {
  checkCheckIn,
  checkRecognition,
  checkResponse,
  checkSurveyDefinition,
  checkSurveyMove,
  MAX_CHECK_IN_NOTE,
  MAX_FREE_TEXT,
  MAX_QUESTION_TEXT,
  MAX_QUESTIONS,
  MAX_RECOGNITION,
  MIN_GROUP_SIZE_RATE_KEY,
  minGroupSize,
  resultsVisible,
  type SurveyAnswers,
  type SurveyQuestion,
  type SurveyState,
  ukWeekStart,
} from "./wellbeing";

/** Staff wellbeing and voice (scheduling.md section 16; SCHED-011), table-driven. */

const q = (
  id: string,
  kind: SurveyQuestion["kind"] = "scale",
  text = "How supported do you feel?",
) => ({
  id,
  kind,
  text,
});
const QUESTIONS: SurveyQuestion[] = [q("q1"), q("q2", "free_text", "What would help?")];

describe("SCHED-011 rule 1 survey definitions", () => {
  it.each<[string, Parameters<typeof checkSurveyDefinition>[0], string | null]>([
    [
      "a valid survey",
      { questions: QUESTIONS, opensOn: "2026-11-02", closesOn: "2026-11-09" },
      null,
    ],
    ["one day", { questions: QUESTIONS, opensOn: "2026-11-02", closesOn: "2026-11-02" }, null],
    [
      "no questions",
      { questions: [], opensOn: "2026-11-02", closesOn: "2026-11-09" },
      "no_questions",
    ],
    [
      "too many",
      {
        questions: Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => q(`q${i}`)),
        opensOn: "2026-11-02",
        closesOn: "2026-11-09",
      },
      "too_many_questions",
    ],
    [
      "the most allowed",
      {
        questions: Array.from({ length: MAX_QUESTIONS }, (_, i) => q(`q${i}`)),
        opensOn: "2026-11-02",
        closesOn: "2026-11-09",
      },
      null,
    ],
    [
      "duplicate ids",
      { questions: [q("q1"), q("q1")], opensOn: "2026-11-02", closesOn: "2026-11-09" },
      "duplicate_question",
    ],
    [
      "blank text",
      { questions: [q("q1", "scale", "  ")], opensOn: "2026-11-02", closesOn: "2026-11-09" },
      "question_text_required",
    ],
    [
      "long text",
      {
        questions: [q("q1", "scale", "a".repeat(MAX_QUESTION_TEXT + 1))],
        opensOn: "2026-11-02",
        closesOn: "2026-11-09",
      },
      "question_text_too_long",
    ],
    [
      "closes before it opens",
      { questions: QUESTIONS, opensOn: "2026-11-09", closesOn: "2026-11-02" },
      "closes_before_opens",
    ],
  ])("%s", (_name, input, expected) => {
    expect(checkSurveyDefinition(input)).toBe(expected);
  });

  it.each<[SurveyState, SurveyState, string | null]>([
    ["draft", "open", null],
    ["open", "closed", null],
    ["draft", "closed", "wrong_state"],
    ["open", "draft", "wrong_state"],
    ["closed", "open", "wrong_state"],
    ["closed", "closed", "wrong_state"],
  ])("moves %s to %s", (from, to, expected) => {
    expect(checkSurveyMove(from, to)).toBe(expected);
  });
});

describe("SCHED-011 rule 2 responses fit the questions", () => {
  it.each<[string, SurveyAnswers, string | null]>([
    ["a scale and a text", { q1: 4, q2: "More time for handover" }, null],
    ["one answer is enough", { q1: 1 }, null],
    ["the highest point", { q1: 5 }, null],
    ["nothing answered", {}, "nothing_answered"],
    ["an unknown question", { q9: 3 }, "unknown_question"],
    ["below the scale", { q1: 0 }, "scale_out_of_range"],
    ["above the scale", { q1: 6 }, "scale_out_of_range"],
    ["not whole", { q1: 2.5 }, "scale_out_of_range"],
    ["text for a scale", { q1: "four" }, "wrong_kind"],
    ["a number for text", { q2: 3 }, "wrong_kind"],
    ["blank text", { q2: "   " }, "free_text_empty"],
    ["long text", { q2: "a".repeat(MAX_FREE_TEXT + 1) }, "free_text_too_long"],
    ["the longest text", { q2: "a".repeat(MAX_FREE_TEXT) }, null],
  ])("%s", (_name, answers, expected) => {
    expect(checkResponse(QUESTIONS, answers)).toBe(expected);
  });
});

describe("SCHED-011 rule 3 a response keeps the UK week only", () => {
  it.each<[string, string, string]>([
    ["a Monday", "2026-11-02T09:00:00Z", "2026-11-02"],
    ["a Wednesday", "2026-11-04T23:30:00Z", "2026-11-02"],
    ["a Sunday", "2026-11-08T12:00:00Z", "2026-11-02"],
    ["Sunday night in BST is Monday in the UK", "2026-03-29T23:30:00Z", "2026-03-30"],
    ["late Sunday UTC in summer is already Monday", "2026-07-05T23:30:00Z", "2026-07-06"],
    ["the autumn clock change", "2026-10-25T01:30:00Z", "2026-10-19"],
    ["across a year end", "2027-01-01T10:00:00Z", "2026-12-28"],
  ])("%s", (_name, instant, expected) => {
    expect(ukWeekStart(new Date(instant))).toBe(expected);
  });
});

const rate = (value: number, tenantId: string | null, nation = "all"): RateRow => ({
  key: MIN_GROUP_SIZE_RATE_KEY,
  value,
  unit: "people",
  nation,
  validFrom: "2000-01-01",
  validTo: null,
  tenantId,
  verificationStatus: "to-verify",
  source: "test",
});

describe("SCHED-011 rule 4 the minimum group size", () => {
  it.each<[string, RateRow[], number | null]>([
    ["the global figure", [rate(5, null)], 5],
    ["an organisation raises it", [rate(5, null), rate(8, "t1")], 8],
    ["an organisation cannot lower it", [rate(5, null), rate(2, "t1")], 5],
    ["another organisation's row is ignored", [rate(5, null), rate(9, "t2")], 5],
    ["no global figure: nothing shows", [rate(8, "t1")], null],
    ["no rows", [], null],
  ])("%s", (_name, rows, expected) => {
    expect(minGroupSize(rows, "england", "2026-11-02", "t1")).toBe(expected);
  });

  it.each<[SurveyState, number, number | null, ReturnType<typeof resultsVisible>]>([
    ["closed", 5, 5, { visible: true }],
    ["closed", 6, 5, { visible: true }],
    ["closed", 4, 5, { visible: false, reason: "too_few" }],
    ["closed", 0, 5, { visible: false, reason: "too_few" }],
    ["open", 50, 5, { visible: false, reason: "still_open" }],
    ["draft", 0, 5, { visible: false, reason: "still_open" }],
    ["closed", 50, null, { visible: false, reason: "no_size" }],
  ])("%s with %i answers and size %s", (state, answered, size, expected) => {
    expect(resultsVisible(state, answered, size)).toEqual(expected);
  });
});

describe("SCHED-011 rules 5 and 6 recognition and check-ins", () => {
  it.each<[string, Parameters<typeof checkRecognition>[0], string | null]>([
    [
      "thanks a colleague",
      { fromMemberId: "a", toMemberId: "b", message: "Thank you for covering" },
      null,
    ],
    ["never oneself", { fromMemberId: "a", toMemberId: "a", message: "Well done me" }, "to_self"],
    ["needs words", { fromMemberId: "a", toMemberId: "b", message: " " }, "message_required"],
    [
      "not too long",
      { fromMemberId: "a", toMemberId: "b", message: "a".repeat(MAX_RECOGNITION + 1) },
      "message_too_long",
    ],
  ])("%s", (_name, input, expected) => {
    expect(checkRecognition(input)).toBe(expected);
  });

  it.each<[string, Parameters<typeof checkCheckIn>[0], string | null]>([
    ["a mood", { mood: 3, note: null }, null],
    ["with a note", { mood: 1, note: "A hard week" }, null],
    ["below", { mood: 0, note: null }, "mood_out_of_range"],
    ["above", { mood: 6, note: null }, "mood_out_of_range"],
    ["not whole", { mood: 3.5, note: null }, "mood_out_of_range"],
    ["a long note", { mood: 3, note: "a".repeat(MAX_CHECK_IN_NOTE + 1) }, "note_too_long"],
  ])("%s", (_name, input, expected) => {
    expect(checkCheckIn(input)).toBe(expected);
  });
});

import type { PulseQuestionResult, PulseSurveyItem, SurveyQuestion } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  questionView,
  readAnswers,
  readSurvey,
  surveyMoves,
  surveyStateChip,
  toAnswer,
  wellbeingAccess,
  wellbeingNavShown,
} from "./wellbeing";

const t = createTranslator("en-GB");

function form(entries: Record<string, string | readonly string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    for (const v of typeof value === "string" ? [value] : value) data.append(key, v);
  }
  return data;
}

const date = (name: string, day: string, month: string, year: string) => ({
  [`${name}-day`]: day,
  [`${name}-month`]: month,
  [`${name}-year`]: year,
});

const QUESTIONS: SurveyQuestion[] = [
  { id: "q1", kind: "scale", text: "I feel supported" },
  { id: "q2", kind: "free_text", text: "What would help?" },
];

describe("SCHED-011 results show only when the API allows, scale counts all or none (slice 61)", () => {
  const base: PulseQuestionResult = {
    id: "q1",
    kind: "scale",
    text: "I feel supported",
    visible: true,
  };

  it.each([
    ["hidden by the API", { ...base, visible: false, counts: [5, 5, 5, 5, 5] }, { kind: "hidden" }],
    [
      "every count shown",
      { ...base, answered: 25, counts: [5, 5, 5, 5, 5] },
      { kind: "scale", answered: 25, counts: [5, 5, 5, 5, 5] },
    ],
    [
      "one count hidden hides them all",
      { ...base, answered: 25, counts: [null, 6, 7, 6, 6] },
      { kind: "scale", answered: 25, counts: null },
    ],
    [
      "counts missing hide them all",
      { ...base, answered: 25 },
      { kind: "scale", answered: 25, counts: null },
    ],
    [
      "too few counts hide them all",
      { ...base, answered: 25, counts: [5, 5, 5] },
      { kind: "scale", answered: 25, counts: null },
    ],
    [
      "a unanimous answer hides every count",
      { ...base, answered: 6, counts: [0, 0, 0, 0, 6] },
      { kind: "scale", answered: 6, counts: null },
    ],
    [
      "a point holding more than the answers less the size hides every count",
      { ...base, answered: 12, counts: [0, 0, 0, 4, 8] },
      { kind: "scale", answered: 12, counts: null },
    ],
    [
      "free text in the API's order",
      { id: "q2", kind: "free_text", text: "x", visible: true, answered: 6, texts: ["a", "b"] },
      { kind: "free_text", answered: 6, texts: ["a", "b"] },
    ],
  ] as const)("%s", (_, input, expected) => {
    expect(questionView(input as PulseQuestionResult, 5)).toEqual(expected);
  });

  it("hides every count when no size is in force", () => {
    expect(questionView({ ...base, answered: 25, counts: [5, 5, 5, 5, 5] }, null)).toEqual({
      kind: "scale",
      answered: 25,
      counts: null,
    });
  });

  it("never shows a count, average or text below the size in the words", () => {
    expect(t("scheduling.wellbeing.results.questionHidden", { size: 5 })).toBe(
      "Fewer than 5 people answered this question, so its answers are not shown.",
    );
  });
});

describe("SCHED-011 the answer form records only the answers (slice 61)", () => {
  it("reads scale points and words, leaving out blank answers", () => {
    expect(
      readAnswers(form({ "answer-q1": "4", "answer-q2": " More time " }), QUESTIONS, t),
    ).toEqual({
      ok: true,
      answers: { q1: 4, q2: "More time" },
    });
    expect(readAnswers(form({ "answer-q2": "Rota" }), QUESTIONS, t)).toEqual({
      ok: true,
      answers: { q2: "Rota" },
    });
  });

  it.each([
    [{}, ["answer-q1"]],
    [{ "answer-q1": "6" }, ["answer-q1"]],
    [{ "answer-q1": "0" }, ["answer-q1"]],
    [{ "answer-q2": "x".repeat(2001) }, ["answer-q2"]],
  ])("refuses %j", (entries, fields) => {
    const read = readAnswers(form(entries), QUESTIONS, t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems.map((p) => p.field)).toEqual(fields);
  });

  it("says plainly what is and is not recorded", () => {
    expect(t("scheduling.wellbeing.answer.recordedTookPart")).toMatch(/took part/);
    expect(t("scheduling.wellbeing.answer.notRecordedName")).toMatch(/name/);
    expect(t("scheduling.wellbeing.answer.notRecordedTime")).toMatch(/When you answered/);
    expect(t("scheduling.wellbeing.answer.resultsWhen")).toMatch(/only after the survey closes/);
  });
});

describe("SCHED-011 writing a survey (slice 61)", () => {
  const good = {
    locationId: "organisation",
    title: "Autumn pulse",
    ...date("opensOn", "02", "11", "2026"),
    ...date("closesOn", "16", "11", "2026"),
    "q-1-kind": "scale",
    "q-1-text": "I feel supported",
    "q-2-kind": "free_text",
    "q-2-text": "What would help?",
  };

  it("reads a survey for the whole organisation, numbering the questions", () => {
    expect(readSurvey(form(good), 2, t)).toEqual({
      ok: true,
      draft: {
        locationId: null,
        title: "Autumn pulse",
        questions: [
          { id: "q1", kind: "scale", text: "I feel supported" },
          { id: "q2", kind: "free_text", text: "What would help?" },
        ],
        opensOn: "2026-11-02",
        closesOn: "2026-11-16",
      },
    });
  });

  it.each([
    ["no place", { ...good, locationId: "" }, ["locationId"]],
    ["no title", { ...good, title: " " }, ["title"]],
    ["closing before opening", { ...good, ...date("closesOn", "01", "11", "2026") }, ["closesOn"]],
    ["a date not real", { ...good, ...date("opensOn", "31", "02", "2026") }, ["opensOn"]],
    ["a question without words", { ...good, "q-2-text": "" }, ["q-2-text"]],
    ["a question without a kind", { ...good, "q-1-kind": "" }, ["q-1-kind"]],
  ] as const)("refuses %s", (_, entries, fields) => {
    const read = readSurvey(form(entries), 2, t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems.map((p) => p.field)).toEqual(fields);
  });

  it.each([
    ["draft", ["open"]],
    ["open", ["close"]],
    ["closed", []],
  ] as const)("offers %s the moves %j, never back", (state, moves) => {
    expect(surveyMoves(state)).toEqual(moves);
    expect(surveyStateChip(state, t).label).not.toBe("");
  });
});

describe("SCHED-011 surveys to answer and access", () => {
  const survey = (state: PulseSurveyItem["state"], answered: boolean | null) =>
    ({ id: `${state}-${answered}`, state, answered }) as PulseSurveyItem;

  it("lists only open surveys not yet answered", () => {
    expect(
      toAnswer([survey("open", false), survey("open", true), survey("closed", false)]).map(
        (s) => s.id,
      ),
    ).toEqual(["open-false"]);
  });

  it.each([
    [["scheduling.wellbeing.self"], true],
    [["scheduling.wellbeing.manage"], true],
    [["care.note.read"], false],
  ])("shows wellbeing for %j: %s", (permissions, shown) => {
    expect(wellbeingNavShown(permissions)).toBe(shown);
  });

  it("reads each access separately", () => {
    expect(wellbeingAccess(["scheduling.wellbeing.manage"])).toEqual({ self: false, manage: true });
  });

  it("keeps a check-in private unless the member shares it, in words", () => {
    expect(t("scheduling.wellbeing.checkIn.sharedState", { shared: "no" })).toBe("Private");
    expect(t("scheduling.wellbeing.checkIn.shareHint")).toMatch(/unticked to keep it to yourself/);
  });
});

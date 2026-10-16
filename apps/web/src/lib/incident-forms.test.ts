import {
  ABUSE_TYPES,
  CLASSIFIER_QUESTION_KEYS,
  CLASSIFIER_QUESTIONS,
  RIDDOR_EXCLUDED_CAUSES,
  SPECIFIED_INJURIES,
} from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  POINT_OF_CARE_QUESTIONS,
  questionField,
  questionsYouMayAnswer,
  questionWords,
  readAnswer,
  readAnswers,
  readIncidentForm,
} from "./incident-forms";
import { notificationsView } from "./incidents";

const t = createTranslator("en-GB");
const PERSON = "0194d000-0000-7000-8600-000000000003";
const HOME = "0194d000-0000-7000-8000-000000000101";
const MEWS = "0194d000-0000-7000-8000-000000000150";
const NOW = new Date("2026-10-16T09:30:00Z");
const FALLS = POINT_OF_CARE_QUESTIONS.map((key) => CLASSIFIER_QUESTIONS[key]);

function form(entries: Record<string, string | readonly string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) {
    for (const item of typeof value === "string" ? [value] : value) data.append(name, item);
  }
  return data;
}

const filled = {
  type: "near_miss",
  "occurredAt-mode": "now",
  description: "A hoist sling nearly gave way.",
  emergencyServicesCalled: "no",
  gpContacted: "yes",
};

describe("the classifier's questions in the catalogue's words (HZ-013)", () => {
  it("hazard HZ-090 has catalogue words for every question, its guidance and every option", () => {
    for (const key of CLASSIFIER_QUESTION_KEYS) {
      const question = CLASSIFIER_QUESTIONS[key];
      const words = questionWords(question, t);
      // The catalogue repeats the domain's words, the regulations' own where it quotes them.
      expect(words.text, key).toEqual({ text: question.text, lang: null });
      expect(words.help, key).toEqual(question.help ? { text: question.help, lang: null } : null);
      for (const option of words.options) {
        const domain = question.options.find((o) => o.value === option.value);
        expect(option, `${key} ${option.value}`).toEqual({
          value: option.value,
          text: domain?.label,
          lang: null,
        });
      }
    }
    for (const option of [...ABUSE_TYPES, ...SPECIFIED_INJURIES, ...RIDDOR_EXCLUDED_CAUSES]) {
      expect(t("safety.question.option", { option: option.value })).toBe(option.label);
    }
  });

  it("hazard HZ-090 shows a question or option the catalogue does not know in the API's English, marked", () => {
    const words = questionWords(
      {
        key: "new.question",
        kind: "choice",
        text: "A new question?",
        help: "Some help.",
        options: [{ value: "a", label: "Option A" }],
      },
      t,
    );
    expect(words.text).toEqual({ text: "A new question?", lang: "en-GB" });
    expect(words.help).toEqual({ text: "Some help.", lang: "en-GB" });
    expect(words.options).toEqual([{ value: "a", text: "Option A", lang: "en-GB" }]);
    const known = questionWords(
      {
        ...CLASSIFIER_QUESTIONS["riddor.excluded_cause"],
        options: [{ value: "weather", label: "Bad weather" }],
      },
      t,
    );
    expect(known.text.lang).toBeNull();
    expect(known.options).toEqual([{ value: "weather", text: "Bad weather", lang: "en-GB" }]);
  });
});

describe("hazard HZ-013 who may answer which questions (ADR-0071)", () => {
  const open = CLASSIFIER_QUESTION_KEYS.map((key) => ({ key }));
  const base = {
    canReport: true,
    manages: false,
    raisedByYou: false,
    closed: false,
    restricted: false,
  };
  it.each([
    ["a manager answers every question", { manages: true }, open.length],
    ["the reporter answers the falls questions", { raisedByYou: true }, 2],
    ["anyone else answers none", {}, 0],
    ["no one answers on a closed incident", { manages: true, closed: true }, 0],
    ["no one answers on a partly hidden incident", { manages: true, restricted: true }, 0],
    ["no one answers without report", { manages: true, canReport: false }, 0],
  ] as const)("%s", (_, context, count) => {
    expect(questionsYouMayAnswer(open, { ...base, ...context })).toHaveLength(count);
  });

  it.each([
    [2, "Answer them below."],
    [1, "Answer the ones below."],
    [0, "Tell the nurse in charge"],
  ])("hazard HZ-013 with %i of 2 answerable, the notice says who answers", (answerable, words) => {
    const view = notificationsView(
      {
        nationSupported: true,
        openQuestions: FALLS.map((q) => ({ ...q, options: [...q.options], sources: [] })),
        pending: [],
        notifications: [],
        outputs: [],
        tasks: [],
      },
      { canSubmit: false, canManage: false, closed: false, now: NOW, answerable },
      t,
    );
    expect(view.notices[0]?.body).toContain(words);
  });
});

describe("hazard HZ-090 reading an answer: not sure is an answer, blank is not", () => {
  const q = (key: keyof typeof CLASSIFIER_QUESTIONS) => CLASSIFIER_QUESTIONS[key];
  const field = (key: string) => questionField(key);
  it.each([
    ["police.involved", {}, { blank: true }],
    ["police.involved", { yes: "yes" }, { answer: { key: "police.involved", value: "yes" } }],
    ["police.involved", { yes: "unsure" }, { answer: { key: "police.involved", value: "unsure" } }],
    ["police.involved", { yes: "maybe" }, { error: "choice" }],
    ["harm.pain_days", { yes: "0" }, { answer: { key: "harm.pain_days", value: 0 } }],
    ["harm.pain_days", { yes: "12" }, { answer: { key: "harm.pain_days", value: 12 } }],
    ["harm.pain_days", { yes: "1.5" }, { error: "number" }],
    ["harm.pain_days", { yes: "-1" }, { error: "number" }],
    ["harm.pain_days", { yes: "100001" }, { error: "number" }],
    [
      "harm.pain_days",
      { unsure: "unsure" },
      { answer: { key: "harm.pain_days", value: "unsure" } },
    ],
    ["harm.pain_days", { yes: "3", unsure: "unsure" }, { error: "both" }],
    [
      "riddor.excluded_cause",
      { yes: "none" },
      { answer: { key: "riddor.excluded_cause", value: "none" } },
    ],
    ["riddor.excluded_cause", { yes: "weather" }, { error: "choice" }],
    [
      "safeguarding.types",
      { many: ["physical", "neglect"] },
      { answer: { key: "safeguarding.types", value: ["physical", "neglect"] } },
    ],
    ["safeguarding.types", { many: ["none"] }, { error: "choice" }],
    ["riddor.worker_specified_injury", { many: ["none", "fracture"] }, { error: "noneWithOthers" }],
    ["safeguarding.types", { many: ["unsure", "physical"] }, { error: "unsureWithOthers" }],
    [
      "safeguarding.types",
      { many: ["unsure"] },
      { answer: { key: "safeguarding.types", value: "unsure" } },
    ],
  ] as const)("%s %o", (key, given, expected) => {
    const name = field(key);
    const entries: Record<string, string | readonly string[]> = {};
    if ("yes" in given) entries[name] = given.yes;
    if ("unsure" in given) entries[`${name}-unsure`] = given.unsure;
    if ("many" in given) entries[name] = given.many;
    expect(readAnswer(form(entries), q(key))).toEqual(expected);
  });

  it("asks for at least one answer, and puts each error at its question", () => {
    const questions = [q("police.involved"), q("harm.pain_days")];
    expect(readAnswers(form({}), questions, t)).toEqual({
      ok: false,
      errors: { [field("police.involved")]: "Answer at least one question" },
    });
    expect(
      readAnswers(
        form({ [field("police.involved")]: "no", [field("harm.pain_days")]: "x" }),
        questions,
        t,
      ),
    ).toEqual({
      ok: false,
      errors: { [field("harm.pain_days")]: "Enter a whole number, or tick not sure yet" },
    });
    expect(readAnswers(form({ [field("police.involved")]: "no" }), questions, t)).toEqual({
      ok: true,
      answers: [{ key: "police.involved", value: "no" }],
    });
  });
});

describe("reading the record an incident form (#42 review; HZ-027)", () => {
  const context = { personId: null, locationIds: [HOME, MEWS], fallQuestions: FALLS, now: NOW };

  it("hazard HZ-090 never assumes no: emergency services and the GP are asked every time", () => {
    const read = readIncidentForm(
      form({ ...filled, location: HOME, emergencyServicesCalled: "", gpContacted: "" }),
      context,
      t,
    );
    expect(read).toEqual({
      ok: false,
      errors: {
        emergencyServicesCalled: "Say whether the emergency services were called",
        gpContacted: "Say whether the GP was contacted",
      },
    });
  });

  it("hazard HZ-090 asks whether the person died when it is about someone, and adds them as affected", () => {
    const about = { ...context, personId: PERSON, locationIds: [HOME] };
    expect(readIncidentForm(form(filled), about, t)).toEqual({
      ok: false,
      errors: { died: "Say whether the person died" },
    });
    const read = readIncidentForm(
      form({ ...filled, died: "no", injuryDetails: "A graze on the left elbow." }),
      about,
      t,
    );
    expect(read).toEqual({
      ok: true,
      draft: {
        locationId: HOME,
        type: "near_miss",
        occurredAt: NOW.toISOString(),
        description: "A hoist sling nearly gave way.",
        emergencyServicesCalled: false,
        gpContacted: true,
        people: [
          {
            kind: "service_user",
            role: "affected",
            personId: PERSON,
            died: false,
            bodyMapMarkIds: [],
            injuryDetails: "A graze on the left elbow.",
          },
        ],
        answers: [],
      },
    });
  });

  it("hazard HZ-027 a fall asks the point-of-care questions, not sure yet included", () => {
    const fall = { ...filled, type: "fall", location: MEWS };
    const unanswered = readIncidentForm(form(fall), context, t);
    expect(unanswered.ok).toBe(false);
    expect(!unanswered.ok && Object.keys(unanswered.errors)).toEqual(
      FALLS.map((q) => questionField(q.key)),
    );
    const read = readIncidentForm(
      form({
        ...fall,
        [questionField("falls.head_injury")]: "unsure",
        [questionField("falls.anticoagulant")]: "yes",
        severity: "minor",
        harmGrade: "low",
      }),
      context,
      t,
    );
    expect(read.ok && read.draft).toMatchObject({
      locationId: MEWS,
      type: "fall",
      severity: "minor",
      harmGrade: "low",
      answers: [
        { key: "falls.head_injury", value: "unsure" },
        { key: "falls.anticoagulant", value: "yes" },
      ],
    });
  });

  it("refuses a location it does not offer, an unknown type and a short description", () => {
    const read = readIncidentForm(
      form({ ...filled, location: PERSON, type: "picnic", description: "ab" }),
      context,
      t,
    );
    expect(!read.ok && Object.keys(read.errors)).toEqual(["location", "type", "description"]);
  });

  it("reads an earlier time from the boxes, and puts a time it cannot read at its boxes", () => {
    const read = readIncidentForm(
      form({
        ...filled,
        location: HOME,
        "occurredAt-mode": "earlier",
        "occurredAt-day": "16",
        "occurredAt-month": "10",
        "occurredAt-year": "2026",
        "occurredAt-hour": "25",
        "occurredAt-minute": "00",
      }),
      context,
      t,
    );
    expect(read.ok).toBe(false);
    expect(!read.ok && read.parts?.occurredAt).toContain("hour");
  });
});

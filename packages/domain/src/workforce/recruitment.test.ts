import { describe, expect, it } from "vitest";
import {
  type ApplicationMove,
  type ApplicationMoveProblem,
  type ApplicationStage,
  applicantRetainUntil,
  checkApplicationMove,
  checkNewApplication,
  EQUALITY_QUESTIONS,
  equalityMonitoringSummary,
  interviewTotal,
  type JobTemplateFacts,
  offerConditions,
  PREFER_NOT_TO_SAY,
  validEqualityAnswers,
} from "./recruitment";

const template: JobTemplateFacts = {
  essentialCriteria: ["Right to work in the UK", "Can work weekends"],
  valuesQuestions: [
    { key: "q1", value: "compassion", question: "Tell us about a time you comforted someone." },
    { key: "q2", value: "courage", question: "When did you speak up about something wrong?" },
  ],
  registration: null,
};

const PANEL = ["0194d000-0000-7000-8000-00000000a001", "0194d000-0000-7000-8000-00000000a002"];
const interview = (overrides: Partial<Extract<ApplicationMove, { to: "interviewed" }>> = {}) =>
  ({
    to: "interviewed",
    panel: PANEL,
    scores: { q1: 3, q2: 4 },
    recommendation: "proceed",
    ...overrides,
  }) as const;

describe("checkApplicationMove (workforce.md rule 11)", () => {
  const cases: readonly [
    string,
    ApplicationStage,
    ApplicationMove,
    ApplicationMoveProblem | ApplicationStage,
  ][] = [
    [
      "shortlists with every criterion met",
      "applied",
      { to: "shortlisted", assessment: [true, true] },
      "shortlisted",
    ],
    [
      "refuses to shortlist with a criterion not met",
      "applied",
      { to: "shortlisted", assessment: [true, false] },
      "criteria_not_met",
    ],
    [
      "refuses to shortlist with a criterion not assessed",
      "applied",
      { to: "shortlisted", assessment: [true] },
      "criteria_not_all_assessed",
    ],
    [
      "rejects with a criterion not met and a reason",
      "applied",
      { to: "rejected", reason: "criteria_not_met", assessment: [true, false] },
      "rejected",
    ],
    [
      "rejects after interview",
      "interviewed",
      { to: "rejected", reason: "not_selected_after_interview" },
      "rejected",
    ],
    ["records an interview once shortlisted", "shortlisted", interview(), "interviewed"],
    ["records a second interview", "interviewed", interview(), "interviewed"],
    ["refuses an interview before shortlisting", "applied", interview(), "not_allowed_from_stage"],
    ["refuses an empty panel", "shortlisted", interview({ panel: [] }), "panel_size"],
    [
      "refuses a panel of six",
      "shortlisted",
      interview({ panel: ["a", "b", "c", "d", "e", "f"] }),
      "panel_size",
    ],
    [
      "refuses a panel member named twice",
      "shortlisted",
      interview({ panel: ["a", "a"] }),
      "panel_repeated",
    ],
    [
      "refuses a question left unscored",
      "shortlisted",
      interview({ scores: { q1: 3 } }),
      "scores_incomplete",
    ],
    [
      "refuses a score for a question not asked",
      "shortlisted",
      interview({ scores: { q1: 3, q2: 2, q3: 1 } }),
      "scores_incomplete",
    ],
    [
      "refuses a score of 0",
      "shortlisted",
      interview({ scores: { q1: 0, q2: 2 } }),
      "score_out_of_range",
    ],
    [
      "refuses a score of 5",
      "shortlisted",
      interview({ scores: { q1: 5, q2: 2 } }),
      "score_out_of_range",
    ],
    [
      "refuses a part score",
      "shortlisted",
      interview({ scores: { q1: 2.5, q2: 2 } }),
      "score_out_of_range",
    ],
    [
      "offers after a recommendation to proceed",
      "interviewed",
      { to: "offered", lastRecommendation: "proceed" },
      "offered",
    ],
    [
      "refuses an offer the panel did not recommend",
      "interviewed",
      { to: "offered", lastRecommendation: "do_not_proceed" },
      "not_recommended",
    ],
    [
      "refuses an offer with no interview",
      "shortlisted",
      { to: "offered", lastRecommendation: null },
      "not_allowed_from_stage",
    ],
    [
      "accepts with the member of staff",
      "offered",
      { to: "accepted", staffMemberId: PANEL[0] ?? "" },
      "accepted",
    ],
    [
      "refuses acceptance without the member of staff",
      "offered",
      { to: "accepted", staffMemberId: null },
      "staff_member_required",
    ],
    ["declines an offer", "offered", { to: "declined" }, "declined"],
    [
      "withdraws with a reason",
      "shortlisted",
      { to: "withdrawn", reason: "applicant_withdrew" },
      "withdrawn",
    ],
    [
      "never reopens a rejected application",
      "rejected",
      { to: "shortlisted", assessment: [true, true] },
      "closed",
    ],
    [
      "never reopens an accepted one",
      "accepted",
      { to: "withdrawn", reason: "applicant_withdrew" },
      "closed",
    ],
    ["never moves a declined one", "declined", interview(), "closed"],
  ];
  it.each(cases)("%s", (_name, stage, move, expected) => {
    const check = checkApplicationMove(stage, template, move);
    if (check.ok) expect(check.to).toBe(expected);
    else expect(check.problem).toBe(expected);
  });

  it("says when a move closes the application", () => {
    const closes = (stage: ApplicationStage, move: ApplicationMove) => {
      const check = checkApplicationMove(stage, template, move);
      return check.ok && check.closes;
    };
    expect(closes("offered", { to: "declined" })).toBe(true);
    expect(closes("applied", { to: "shortlisted", assessment: [true, true] })).toBe(false);
  });

  it("takes applications only while the vacancy is open", () => {
    expect(checkNewApplication("open").ok).toBe(true);
    for (const status of ["draft", "closed", "filled", "withdrawn"] as const) {
      expect(checkNewApplication(status)).toMatchObject({ ok: false, problem: "vacancy_not_open" });
    }
  });
});

describe("interviews and offers", () => {
  it("totals the panel's scores for the people deciding, out of the most possible", () => {
    expect(interviewTotal({ q1: 3, q2: 4 }, template.valuesQuestions)).toEqual({
      total: 7,
      outOf: 8,
    });
  });

  it("makes the offer conditional on the role's Schedule 3 items", () => {
    expect(offerConditions({ registration: null, previousCareWork: false })).not.toContain(
      "professional_registration",
    );
    expect(offerConditions({ registration: "nmc", previousCareWork: true })).toEqual(
      expect.arrayContaining([
        "professional_registration",
        "conduct_in_care_work",
        "dbs_certificate",
      ]),
    );
  });
});

describe("equalityMonitoringSummary (rule 12; DPIA risk R29)", () => {
  it("shows counts, suppresses those under 5 and withholds a question too few answered", () => {
    const summary = equalityMonitoringSummary([
      { question: "__forms", answer: "", n: 12 },
      { question: "sex", answer: "female", n: 8 },
      { question: "sex", answer: "male", n: 3 },
      { question: "sex", answer: PREFER_NOT_TO_SAY, n: 1 },
      { question: "disability", answer: "yes", n: 2 },
      { question: "disability", answer: "no", n: 1 },
    ]);
    expect(summary.forms).toBe(12);
    const sex = summary.questions.find((q) => q.question === "sex");
    expect(sex?.counts).toEqual({
      female: 8,
      male: "fewer_than_min",
      [PREFER_NOT_TO_SAY]: "fewer_than_min",
    });
    // Three people answered the disability question: nothing about it is shown.
    expect(summary.questions.find((q) => q.question === "disability")?.counts).toBeNull();
    expect(summary.questions.map((q) => q.question)).toEqual(Object.keys(EQUALITY_QUESTIONS));
  });

  it("suppresses the number of forms itself when under 5", () => {
    expect(equalityMonitoringSummary([{ question: "__forms", answer: "", n: 2 }]).forms).toBe(
      "fewer_than_min",
    );
    expect(equalityMonitoringSummary([]).forms).toBe(0);
  });

  it("takes only known questions and offered answers, always with prefer not to say", () => {
    expect(validEqualityAnswers({ sex: "female", disability: PREFER_NOT_TO_SAY })).toBe(true);
    expect(validEqualityAnswers({})).toBe(true);
    expect(validEqualityAnswers({ sex: "unknown" })).toBe(false);
    expect(validEqualityAnswers({ name: "Ada" })).toBe(false);
  });
});

describe("applicantRetainUntil (rule 13)", () => {
  const unsuccessful = { period: 6, unit: "months" as const };
  const cases: readonly [
    string,
    Parameters<typeof applicantRetainUntil>[0]["applications"],
    string | null,
    string | null,
  ][] = [
    ["kept while an application is open", [{ stage: "shortlisted", closedOn: null }], null, null],
    [
      "kept while another is open",
      [
        { stage: "rejected", closedOn: "2026-01-10" },
        { stage: "applied", closedOn: null },
      ],
      null,
      null,
    ],
    [
      "follows the staff file once hired",
      [{ stage: "accepted", closedOn: "2026-02-01" }],
      null,
      null,
    ],
    [
      "six months after the last closing",
      [{ stage: "rejected", closedOn: "2026-03-31" }],
      null,
      "2026-09-30",
    ],
    [
      "counts from the latest of several",
      [
        { stage: "rejected", closedOn: "2026-01-15" },
        { stage: "withdrawn", closedOn: "2026-04-15" },
      ],
      null,
      "2026-10-15",
    ],
    [
      "the talent pool when it ends later",
      [{ stage: "declined", closedOn: "2026-03-01" }],
      "2027-03-01",
      "2027-03-01",
    ],
    [
      "the closing period when the pool ends sooner",
      [{ stage: "rejected", closedOn: "2026-03-01" }],
      "2026-04-01",
      "2026-09-01",
    ],
    ["the talent pool alone with no application", [], "2027-01-01", "2027-01-01"],
  ];
  it.each(cases)("%s", (_name, applications, talentPoolUntil, expected) => {
    expect(applicantRetainUntil({ applications, talentPoolUntil, unsuccessful })).toBe(expected);
  });
});

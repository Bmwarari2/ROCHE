import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { cite } from "../shared/citation";
import {
  type AuditAnswer,
  type AuditRecord,
  type AuditTemplate,
  auditFindingsByStatement,
  auditScoreMethod,
  checkAuditCompletion,
  checkAuditTemplate,
  defaultActionDueOn,
  isValidSelfRating,
  nextAuditDue,
  SELF_RATING_WORDS,
  scoreAudit,
} from "./quality-audits";
import type { FrameworkVersion } from "./quality-framework";
import { resolveQualityPhase2Rates } from "./quality-rates";

const rates = resolveQualityPhase2Rates(readRateTable(), "england", "2026-10-31", null);

const framework: FrameworkVersion = {
  id: "fw-1",
  frameworkKey: "example_framework",
  regulator: "cqc",
  version: 1,
  state: "published",
  publishedOn: "2024-01-01",
  retiredOn: null,
  source: cite("Example regulator", "framework", "https://example.invalid/framework"),
  keyQuestions: [
    {
      id: "safe",
      title: "Safe",
      statements: [
        { id: "safe.1", title: "A" },
        { id: "safe.2", title: "B" },
      ],
    },
  ],
  evidenceCategories: [{ id: "processes", title: "Processes" }],
};

const template: AuditTemplate = {
  key: "medication-monthly",
  title: "Medication audit",
  kind: "medication",
  frameworkVersionId: "fw-1",
  questions: [
    { key: "q1", text: "MAR complete", weight: 2, statementIds: ["safe.1"], actionRequired: true },
    {
      key: "q2",
      text: "Fridge in range",
      weight: 1,
      statementIds: ["safe.1", "safe.2"],
      actionRequired: true,
    },
    { key: "q3", text: "Homely remedies", weight: 1, statementIds: [], actionRequired: false },
  ],
};

const audit = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  templateKey: template.key,
  frameworkVersionId: "fw-1",
  auditedOn: "2026-10-31",
  answers: { q1: "yes", q2: "yes", q3: "not_applicable" },
  selfRating: rates.ratingScaleMax - 1,
  actions: [],
  ...over,
});

describe("audits and mock inspections (quality.md 17.3 rules 8 to 15; QUAL-004)", () => {
  it.each<[string, Partial<AuditTemplate>, string[]]>([
    ["a sound template", {}, []],
    ["no questions", { questions: [] }, ["no_questions"]],
    [
      "a weight that is not a positive whole number",
      {
        questions: [
          { ...template.questions[0], weight: 0.5 } as AuditTemplate["questions"][number],
        ],
      },
      ["invalid_weight"],
    ],
    [
      "a statement outside the framework",
      {
        questions: [
          {
            ...template.questions[0],
            statementIds: ["effective.1"],
          } as AuditTemplate["questions"][number],
        ],
      },
      ["unknown_statement"],
    ],
    ["another framework version", { frameworkVersionId: "fw-2" }, ["wrong_framework"]],
    [
      "a question key used twice",
      { questions: [template.questions[0], template.questions[0]] as AuditTemplate["questions"] },
      ["duplicate_question"],
    ],
  ])("rule 8 checks %s", (_, over, problems) => {
    expect(checkAuditTemplate({ ...template, ...over }, framework)).toEqual(problems);
  });

  it.each<[string, Record<string, AuditAnswer | null>, number | null, boolean]>([
    ["all yes, one not applicable", { q1: "yes", q2: "yes", q3: "not_applicable" }, 100, true],
    ["a partial counts half its weight", { q1: "partial", q2: "yes", q3: "yes" }, 75, true],
    ["a no counts nothing", { q1: "no", q2: "yes", q3: "yes" }, 50, true],
    [
      "nothing answerable gives no score, never 0 or 100",
      { q1: "not_applicable", q2: "not_applicable", q3: "not_applicable" },
      null,
      true,
    ],
    ["an unanswered question leaves it incomplete", { q1: "yes", q2: null }, 100, false],
  ])("rule 9 scores %s", (_, answers, percent, complete) => {
    const score = scoreAudit(template, answers);
    expect(score.percent).toBe(percent);
    expect(score.complete).toBe(complete);
  });

  it("rule 9 says the method in words beside the score", () => {
    expect(auditScoreMethod(scoreAudit(template, { q1: "partial", q2: "yes", q3: "yes" }))).toBe(
      "3 of 4 weighted points: yes counts in full, partial counts half, no counts nothing, and not applicable is left out.",
    );
    expect(
      auditScoreMethod(
        scoreAudit(template, { q1: "not_applicable", q2: "not_applicable", q3: "not_applicable" }),
      ),
    ).toContain("every answer was not applicable");
  });

  const AUDIT = ["quality.audit.manage"];
  const action = {
    questionKey: "q1",
    description: "Retrain on MAR",
    ownerId: "staff-1",
    dueOn: "2026-11-28",
  };

  it.each<[string, Partial<AuditRecord>, readonly string[], string[]]>([
    ["a complete audit", {}, AUDIT, []],
    [
      "a no with its action",
      { answers: { q1: "no", q2: "yes", q3: "yes" }, actions: [action] },
      AUDIT,
      [],
    ],
    [
      "a no without an action",
      { answers: { q1: "no", q2: "yes", q3: "yes" } },
      AUDIT,
      ["action_missing"],
    ],
    [
      "a partial without an action",
      { answers: { q1: "yes", q2: "partial", q3: "yes" } },
      AUDIT,
      ["action_missing"],
    ],
    ["a no where no action is needed", { answers: { q1: "yes", q2: "yes", q3: "no" } }, AUDIT, []],
    [
      "an action with no owner",
      { answers: { q1: "no", q2: "yes", q3: "yes" }, actions: [{ ...action, ownerId: null }] },
      AUDIT,
      ["action_incomplete"],
    ],
    [
      "an action due before the audit",
      {
        answers: { q1: "no", q2: "yes", q3: "yes" },
        actions: [{ ...action, dueOn: "2026-10-30" }],
      },
      AUDIT,
      ["action_due_before_audit"],
    ],
    [
      "an unanswered question",
      { answers: { q1: "yes", q2: null, q3: "yes" } },
      AUDIT,
      ["unanswered"],
    ],
    ["no self-rating", { selfRating: null }, AUDIT, ["self_rating_missing"]],
    ["someone who does not run audits", {}, [], ["missing_permission"]],
  ])("rule 10 checks completing %s", (_, over, permissions, problems) => {
    expect(checkAuditCompletion(template, audit(over), rates, permissions)).toEqual(problems);
  });

  it("rule 11 takes a whole number on the rate table's CQC scale, with CQC's words", () => {
    expect(isValidSelfRating(rates.ratingScaleMin, rates)).toBe(true);
    expect(isValidSelfRating(rates.ratingScaleMax, rates)).toBe(true);
    expect(isValidSelfRating(rates.ratingScaleMax + 1, rates)).toBe(false);
    expect(isValidSelfRating(rates.ratingScaleMin - 1, rates)).toBe(false);
    expect(isValidSelfRating(2.5, rates)).toBe(false);
    for (let n = rates.ratingScaleMin; n <= rates.ratingScaleMax; n += 1) {
      expect(SELF_RATING_WORDS[n], `word for ${n}`).toBeTruthy();
    }
  });

  it("rule 12 gives an action the tenant's default due date in UK days", () => {
    expect(defaultActionDueOn("2026-10-20", rates)).toBe(
      new Date(Date.UTC(2026, 9, 20 + rates.auditActionDueDays)).toISOString().slice(0, 10),
    );
  });

  it.each<[string, number, string, string, boolean]>([
    ["a monthly audit", 1, "2026-10-31", "2026-11-30", false],
    ["a monthly audit after its due date", 1, "2026-12-01", "2026-11-30", true],
    ["a quarterly audit from the end of January", 3, "2026-04-30", "2026-04-30", false],
  ])("rule 13 schedules %s", (_, months, on, due, overdue) => {
    const last = months === 3 ? "2026-01-31" : "2026-10-31";
    expect(nextAuditDue(last, months, on)).toEqual({ dueOn: due, overdue });
  });

  it("rule 13 refuses a frequency that is not whole months", () => {
    expect(() => nextAuditDue("2026-10-31", 0, "2026-10-31")).toThrow(RangeError);
  });

  it("rule 14 groups what fell short by statement for the evidence library", () => {
    const findings = auditFindingsByStatement(template, { q1: "no", q2: "partial", q3: "no" });
    expect(Object.fromEntries(findings)).toEqual({ "safe.1": ["q1", "q2"], "safe.2": ["q2"] });
  });

  it("rule 15 never works out a rating from a score: a perfect score still needs a person's rating", () => {
    expect(checkAuditCompletion(template, audit({ selfRating: null }), rates, AUDIT)).toContain(
      "self_rating_missing",
    );
  });
});

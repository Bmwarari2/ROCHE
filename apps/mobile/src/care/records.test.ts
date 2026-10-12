import { describe, expect, it } from "vitest";
import type { AssessmentRow, RiskRow } from "./queries";
import { carePlanView, latestAssessments, reviewLine, riskView } from "./records";

const TODAY = "2026-10-11";

describe("care plan summary (read only)", () => {
  const plan = {
    id: "plan",
    published_version: 2,
    summary: "Invented summary",
    review_due_on: "2026-10-01",
    published_at: "2026-08-01T10:00:00.000000Z",
  };

  it("orders sections by the PCSP domains, leaves out empty ones and lists their actions", () => {
    const view = carePlanView(
      plan,
      [
        {
          id: "s2",
          domain: "nutrition_and_hydration",
          need: "Soft diet",
          outcome: null,
          strengths: null,
          contingency: null,
        },
        {
          id: "s1",
          domain: "mobility",
          need: "Frame",
          outcome: "I want to walk",
          strengths: null,
          contingency: null,
        },
        {
          id: "s3",
          domain: "sleep",
          need: null,
          outcome: null,
          strengths: null,
          contingency: null,
        },
      ],
      [
        {
          id: "a1",
          section_id: "s1",
          action: "Walk to the lounge",
          role_key: "care_worker",
          when_text: "Before lunch",
        },
        { id: "a2", section_id: "s2", action: "Offer drinks", role_key: null, when_text: null },
      ],
      TODAY,
    );
    expect(view.version).toBe("Version 2, published 01/08/2026");
    expect(view.sections.map((s) => s.title)).toEqual(["Mobility", "Nutrition and hydration"]);
    expect(view.sections[0]?.actions).toEqual([
      {
        id: "a1",
        action: "Walk to the lounge",
        who: "Who: Care worker",
        when: "When: Before lunch",
      },
    ]);
    expect(view.sections[1]?.actions[0]).toMatchObject({ who: null, when: "When: As needed" });
  });

  it("says in words when the review is overdue", () => {
    expect(carePlanView(plan, [], [], TODAY).review).toEqual({
      text: "Review overdue since 01/10/2026",
      overdue: true,
    });
    expect(
      reviewLine("2026-10-11", TODAY, {
        due: "mobile.carePlan.review",
        overdue: "mobile.carePlan.reviewOverdue",
      }),
    ).toEqual({ text: "Review due 11/10/2026", overdue: false });
  });
});

describe("risk assessments (read only)", () => {
  const risk: RiskRow = {
    id: "r1",
    template_key: "choking",
    hazard: "Choking",
    who_at_risk: "Ada",
    risk_rating: 8,
    risk_band: "high",
    residual_rating: 4,
    residual_band: "moderate",
    controls: '["Minced and moist diet","Sit upright"]',
    positive_risk_statement: null,
    person_views: null,
    assessed_on: "2026-08-01",
    review_due_on: "2027-01-01",
  };

  it("shows the rating before and with controls, in words", () => {
    expect(riskView(risk, TODAY)).toMatchObject({
      hazard: "Choking",
      whoAtRisk: "Who is at risk: Ada",
      rating: "Risk before controls: High, rating 8",
      residual: "Risk with controls: Moderate, rating 4",
      controls: ["Minced and moist diet", "Sit upright"],
      review: { text: "Review due 01/01/2027", overdue: false },
    });
  });

  it("says a falls assessment is not rated rather than showing a blank score", () => {
    const view = riskView(
      {
        ...risk,
        template_key: "falls",
        risk_rating: null,
        risk_band: null,
        residual_rating: null,
        residual_band: null,
      },
      TODAY,
    );
    expect(view.rating).toBe("Not rated");
    expect(view.residual).toBeNull();
  });
});

describe("latest assessment per tool", () => {
  const row = (overrides: Partial<AssessmentRow>): AssessmentRow => ({
    id: "x",
    tool_key: "must",
    score: 0,
    band: "low",
    occurred_at: "2026-09-01T10:00:00.000000Z",
    next_due_on: "2026-10-01",
    supersedes_id: null,
    ...overrides,
  });

  it("keeps the newest result per tool and leaves out one a correction replaced", () => {
    const views = latestAssessments(
      [
        row({ id: "m-old", occurred_at: "2026-08-01T10:00:00.000000Z" }),
        row({
          id: "m-new",
          score: 2,
          band: "high",
          occurred_at: "2026-10-01T10:00:00.000000Z",
          next_due_on: "2026-11-01",
        }),
        row({
          id: "m-fix",
          score: 1,
          band: "medium",
          occurred_at: "2026-09-30T10:00:00.000000Z",
          supersedes_id: "m-new",
        }),
        row({ id: "f1", tool_key: "ng249_falls", score: null, band: null }),
      ],
      TODAY,
    );
    expect(views.map((v) => [v.id, v.tool, v.result])).toEqual([
      ["m-fix", "MUST", "Medium risk, score 1, on 30/09/2026"],
      ["f1", "Falls (NICE NG249)", "Completed on 01/09/2026, not scored"],
    ]);
    expect(views[0]?.nextDue).toEqual({ text: "Overdue since 01/10/2026", overdue: true });
  });
});

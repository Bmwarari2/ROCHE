import { CreateRiskAssessment } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { FormLike } from "./assessment-answers";
import {
  answerField,
  controlLines,
  type RiskTemplate,
  readRiskFields,
  reviewOverdue,
  riskChip,
  splitControls,
} from "./risk";

function form(entries: Record<string, string | string[]>): FormLike {
  return {
    get: (name) => {
      const value = entries[name];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    },
    getAll: (name) => {
      const value = entries[name];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    },
  };
}

const bedRails: RiskTemplate = {
  key: "bed_rails",
  title: "Bed rails",
  version: "harbour-2026-10",
  source: "MHRA",
  rated: true,
  questions: [
    { key: "entrapment_risk", text: "Entrapment?", kind: "yes_no", limit: null },
    {
      key: "gap_rail_to_mattress_mm",
      text: "Gap (mm)",
      kind: "measurement_mm",
      limit: { rateKey: "bed_rail.gap", valueMm: 120, rule: "under", whenYes: null },
    },
    { key: "notes_on_fit", text: "Notes", kind: "text", limit: null },
  ],
  suggestedControls: ["Gaps measured at fitting", "Low bed considered"],
};

const falls: RiskTemplate = { ...bedRails, key: "falls", title: "Falls", rated: false };

describe("risk assessment forms", () => {
  it("reads answers, the assessor's judgements and controls into what the API accepts", () => {
    const fields = readRiskFields(
      form({
        hazard: "Ada could slip between the rail and the mattress.",
        whoAtRisk: "Ada",
        [answerField("entrapment_risk")]: "yes",
        [answerField("gap_rail_to_mattress_mm")]: "70",
        [answerField("notes_on_fit")]: "  ",
        likelihood: "3",
        severity: "4",
        residualLikelihood: "2",
        residualSeverity: "4",
        controls: ["Gaps measured at fitting"],
        otherControls: "Check gaps weekly\n\n  Rail bumpers fitted  ",
        positiveRiskStatement: "",
      }),
      bedRails,
      { assessedOn: "2026-10-11", reviewDueOn: null },
    );
    expect(fields).toMatchObject({
      answers: { entrapment_risk: true, gap_rail_to_mattress_mm: 70 },
      likelihood: 3,
      severity: 4,
      residualLikelihood: 2,
      residualSeverity: 4,
      controls: ["Gaps measured at fitting", "Check gaps weekly", "Rail bumpers fitted"],
      positiveRiskStatement: null,
      personViews: null,
    });
    expect(fields.assessedOn).toBe("2026-10-11");
    expect("reviewDueOn" in fields).toBe(false);
    expect(CreateRiskAssessment.safeParse({ templateKey: "bed_rails", ...fields }).success).toBe(
      true,
    );
  });

  it("never sends a rating for falls (NICE NG249 1.1.1)", () => {
    const fields = readRiskFields(form({ likelihood: "5", severity: "5" }), falls, {
      assessedOn: "2026-10-11",
      reviewDueOn: "2027-01-11",
    });
    expect(fields.reviewDueOn).toBe("2027-01-11");
    expect([fields.likelihood, fields.severity, fields.residualLikelihood]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("refuses scale values off the 1 to 5 scale rather than guessing", () => {
    const fields = readRiskFields(form({ likelihood: "6", severity: "0" }), bedRails, {
      assessedOn: "2026-10-11",
      reviewDueOn: null,
    });
    expect([fields.likelihood, fields.severity]).toEqual([null, null]);
  });

  it("splits controls into the template's and those typed by hand", () => {
    expect(splitControls(["Low bed considered", "Weekly check"], bedRails)).toEqual({
      suggested: ["Low bed considered"],
      other: ["Weekly check"],
    });
    expect(controlLines("a\n\n b \n")).toEqual(["a", "b"]);
  });

  it("shows the band as a chip and says when a review is overdue", () => {
    expect(riskChip("extreme")).toBe("overdue");
    expect(riskChip("moderate")).toBe("due");
    expect(riskChip("low")).toBe("neutral");
    expect(riskChip(null)).toBe("neutral");
    expect(reviewOverdue({ reviewDueOn: "2026-10-10", status: "active" }, "2026-10-11")).toBe(true);
    expect(reviewOverdue({ reviewDueOn: "2026-10-11", status: "active" }, "2026-10-11")).toBe(
      false,
    );
    expect(reviewOverdue({ reviewDueOn: "2026-01-01", status: "closed" }, "2026-10-11")).toBe(
      false,
    );
  });
});

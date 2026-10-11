import { AssessmentToolKey, CarePlanStatus, PcspDomain } from "@harbour/contracts";
import {
  type BradenBand,
  type MustBand,
  VALIDATED_TOOLS,
  type WaterlowBand,
} from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  availableTools,
  bandChip,
  bandLabel,
  fallsDetails,
  isToolKey,
  latestByTool,
  readNumber,
  readTriggers,
  readWholeNumber,
  readYesNo,
  TOOL_KEYS,
  TOOL_SOURCES,
  triggerText,
  triggerTexts,
} from "./assessments";
import { PCSP_DOMAINS, planStatusChip } from "./care-plan";

const t = createTranslator("en-GB");

describe("validated tools", () => {
  it("lists every tool the API knows", () => {
    expect([...TOOL_KEYS].sort()).toEqual([...AssessmentToolKey.options].sort());
    expect(isToolKey("must")).toBe(true);
    expect(isToolKey("news2")).toBe(false);
  });

  it("offers Waterlow and Braden only when their licence flags are on (H-25)", () => {
    expect(availableTools({})).toEqual(["must", "ng249_falls"]);
    expect(availableTools({ "care.tool.waterlow": true, "care.tool.braden": false })).toEqual([
      "must",
      "ng249_falls",
      "waterlow",
    ]);
  });

  it("hazard HZ-012 shows bands in words, using the publisher's wording for Braden", () => {
    expect(bandLabel({ toolKey: "must", band: "high", details: {} }, t)).toBe("High risk");
    expect(bandLabel({ toolKey: "waterlow", band: "very_high_risk", details: {} }, t)).toBe(
      "Very high risk",
    );
    expect(
      bandLabel({ toolKey: "braden", band: "at_risk", details: { bandLabel: "At risk" } }, t),
    ).toBe("At risk");
    expect(bandLabel({ toolKey: "ng249_falls", band: null, details: {} }, t)).toBeNull();
    expect(bandChip({ band: "high" })).toBe("overdue");
    expect(bandChip({ band: "medium" })).toBe("due");
    expect(bandChip({ band: "below_at_risk_threshold" })).toBe("done");
    expect(bandChip({ band: null })).toBe("neutral");
  });

  it("hazard HZ-014 says what a result raised in the API's words, and leaves out what it cannot read", () => {
    expect(
      triggerText(
        { kind: "task", task: "dietitian_referral", reason: "MUST high risk: refer to dietitian" },
        t,
      ),
    ).toBe("Task: MUST high risk: refer to dietitian");
    expect(triggerText({ kind: "task", reason: "Document dietary intake", forDays: 3 }, t)).toBe(
      "Task: Document dietary intake, for 3 days",
    );
    expect(triggerText({ kind: "urgent_alert", reason: "Unsafe texture" }, t)).toBe(
      "Alert to the nurse in charge: Unsafe texture",
    );
    expect(triggerText({ kind: "rescreen", toolKey: "must", dueOn: "2026-11-11" }, t)).toBe(
      "Repeat MUST by 11/11/2026",
    );
    expect(triggerText({ kind: "weight_interval", interval: { unit: "weeks", value: 1 } }, t)).toBe(
      "Weigh every week",
    );
    expect(
      triggerText({ kind: "weight_interval", interval: { unit: "months", value: 3 } }, t),
    ).toBe("Weigh every 3 months");
    expect(
      triggerText({ kind: "repeat_observations", frequency: { text: "Minimum 1 hourly" } }, t),
    ).toBe("Repeat observations: Minimum 1 hourly");
    expect(triggerText({ kind: "unknown" }, t)).toBeNull();
    expect(triggerText({ kind: "task" }, t)).toBeNull();
    expect(
      triggerTexts({ triggers: [{ kind: "x" }, { kind: "urgent_alert", reason: "R" }] }, t),
    ).toEqual(["Alert to the nurse in charge: R"]);
  });

  it("hazard HZ-014 never shows a result that raised something unknown as if it raised nothing", () => {
    expect(
      readTriggers(
        {
          triggers: [
            { kind: "urgent_alert", reason: "R" },
            { kind: "referral", task: "tissue_viability" },
            { kind: "task" },
          ],
        },
        t,
      ),
    ).toEqual({
      texts: ["Alert to the nurse in charge: R"],
      unknown: ["referral (tissue_viability)", "task"],
    });
    expect(t("care.assessments.triggers.unknown", { count: 2, codes: "referral, task" })).toMatch(
      /^2 follow-ups could not be shown \(referral, task\)/,
    );
  });

  it("reads the NG249 recommendation and NICE's reason as stored", () => {
    expect(
      fallsDetails({ details: { recommendation: "1.1.7", reason: "In NICE's words" } }),
    ).toEqual({
      recommendation: "1.1.7",
      reason: "In NICE's words",
    });
    expect(fallsDetails({ details: {} })).toEqual({ recommendation: null, reason: null });
  });

  it("keeps the latest result of each tool", () => {
    const item = (id: string, toolKey: "must" | "braden", occurredAt: string) =>
      ({ id, toolKey, occurredAt }) as Parameters<typeof latestByTool>[0][number];
    const latest = latestByTool([
      item("a", "must", "2026-10-01T09:00:00Z"),
      item("b", "must", "2026-10-05T09:00:00Z"),
      item("c", "braden", "2026-10-02T09:00:00Z"),
    ]);
    expect(latest.must?.id).toBe("b");
    expect(latest.braden?.id).toBe("c");
  });

  it("reads numbers and yes or no answers typed in forms", () => {
    expect(readNumber("62.4")).toBe(62.4);
    expect(readNumber(" 50 ")).toBe(50);
    expect(readNumber("")).toBeNull();
    expect(readNumber("62,4")).toBeNull();
    expect(readNumber("1e400")).toBeNull();
    expect(readNumber(null)).toBeNull();
    expect(readWholeNumber("22")).toBe(22);
    expect(readWholeNumber("22.5")).toBeNull();
    expect(readYesNo("yes")).toBe(true);
    expect(readYesNo("no")).toBe(false);
    expect(readYesNo("maybe")).toBeNull();
  });
});

describe("band wording against the domain's bands (care.md rule 5)", () => {
  // Every band the domain can give, written out so that a new band fails to compile here.
  const mustBands: Record<MustBand, string> = {
    low: "Low risk",
    medium: "Medium risk",
    high: "High risk",
  };
  const waterlowBands: Record<WaterlowBand, string> = {
    not_at_risk: "Not at risk",
    at_risk: "At risk",
    high_risk: "High risk",
    very_high_risk: "Very high risk",
  };

  it("hazard HZ-012 words every MUST and Waterlow band in the catalogue, never by its code", () => {
    for (const [band, words] of Object.entries(mustBands)) {
      expect(bandLabel({ toolKey: "must", band, details: {} }, t)).toBe(words);
    }
    for (const [band, words] of Object.entries(waterlowBands)) {
      expect(bandLabel({ toolKey: "waterlow", band, details: {} }, t)).toBe(words);
    }
  });

  it("shows each band with the strength of chip its risk calls for", () => {
    const bradenBands: Record<BradenBand, true> = {
      severe_risk: true,
      high_risk: true,
      moderate_risk: true,
      at_risk: true,
      below_at_risk_threshold: true,
    };
    for (const band of [
      ...Object.keys(mustBands),
      ...Object.keys(waterlowBands),
      ...Object.keys(bradenBands),
    ]) {
      expect(bandChip({ band }), band).not.toBe("neutral");
    }
  });
});

describe("tool sources on screen (medical-device boundary, section 5 rule 1)", () => {
  it("hazard HZ-012 names the publisher, edition and source the API calculates from", () => {
    for (const tool of ["news2", "must", "waterlow", "braden"] as const) {
      const published = VALIDATED_TOOLS[tool];
      expect(TOOL_SOURCES[tool]).toBe(published.url);
      const words = t("care.assessments.source", { tool });
      expect(words, tool).toContain(published.publisher);
      expect(words, tool).toContain(published.edition);
    }
    expect(t("care.assessments.source", { tool: "ng249_falls" })).toContain("NG249");
  });
});

describe("care plan helpers", () => {
  it("covers the 16 need domains the API knows", () => {
    expect([...PCSP_DOMAINS].sort()).toEqual([...PcspDomain.options].sort());
  });

  it("hazard HZ-024 labels every version in word and icon, and only the active one as in use", () => {
    const chips = CarePlanStatus.options.map((status) => planStatusChip(status, t));
    expect(chips.map((chip) => chip.label)).toEqual([
      "Draft, not in use",
      "In use",
      "Superseded, not in use",
    ]);
    expect(chips.map((chip) => chip.icon)).toEqual(["pencil-line", "circle-check", "history"]);
    expect(chips.filter((chip) => chip.status === "done")).toHaveLength(1);
  });
});

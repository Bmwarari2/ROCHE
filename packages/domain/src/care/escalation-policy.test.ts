import { describe, expect, it } from "vitest";
import type { BradenBand } from "./braden";
import {
  checkEscalationPolicyLink,
  ESCALATION_POLICY_BANDS,
  ESCALATION_POLICY_TOOLS,
  type EscalationPolicyLink,
  escalationPolicyFor,
} from "./escalation-policy";
import type { MustBand } from "./must";
import type { News2Band } from "./news2";
import type { WaterlowBand } from "./waterlow";

/**
 * The organisation's escalation policy linked from a validated tool's result (medical-device
 * boundary section 5 rule 4; hazards HZ-012 and HZ-014; human action H-73).
 */

const HOME = "0194d000-0000-7000-8000-000000000101";
const LODGE = "0194d000-0000-7000-8000-000000000102";

const link = (id: string, over: Partial<EscalationPolicyLink> = {}): EscalationPolicyLink => ({
  id,
  toolKey: "news2",
  band: null,
  locationId: null,
  title: `Policy ${id}`,
  reference: null,
  documentId: null,
  ...over,
});

const LINKS: readonly EscalationPolicyLink[] = [
  link("org-news2"),
  link("org-news2-high", { band: "high" }),
  link("home-news2", { locationId: HOME }),
  link("home-news2-medium", { locationId: HOME, band: "medium" }),
  link("org-must-high", { toolKey: "must", band: "high" }),
  link("org-falls", { toolKey: "ng249_falls" }),
];

describe("hazard HZ-014 a result links the organisation's policy for its tool and band", () => {
  it.each([
    // [case, tool, band, location, expected link, matched on, scope]
    [
      "the location's policy for the band",
      "news2",
      "medium",
      HOME,
      "home-news2-medium",
      "band",
      "location",
    ],
    [
      "the location's policy for every band",
      "news2",
      "high",
      HOME,
      "home-news2",
      "tool",
      "location",
    ],
    [
      "the organisation's policy for the band",
      "news2",
      "high",
      LODGE,
      "org-news2-high",
      "band",
      "organisation",
    ],
    [
      "the organisation's policy for every band",
      "news2",
      "low",
      LODGE,
      "org-news2",
      "tool",
      "organisation",
    ],
    ["a result with no location", "news2", "high", null, "org-news2-high", "band", "organisation"],
    ["a NEWS2 result with no score yet", "news2", null, LODGE, "org-news2", "tool", "organisation"],
    [
      "the falls pathway, which has no band",
      "ng249_falls",
      null,
      HOME,
      "org-falls",
      "tool",
      "organisation",
    ],
    ["MUST high", "must", "high", HOME, "org-must-high", "band", "organisation"],
  ] as const)("%s", (_name, toolKey, band, locationId, id, matchedOn, scope) => {
    expect(escalationPolicyFor(LINKS, { toolKey, band, locationId })).toMatchObject({
      status: "configured",
      toolKey,
      band,
      link: { id },
      matchedOn,
      scope,
    });
  });

  it.each([
    ["a tool with no policy at all", "braden", "high_risk", HOME],
    ["a band no link covers", "must", "medium", HOME],
    ["another organisation's location", "waterlow", "at_risk", null],
  ] as const)(
    "says no escalation policy is configured for %s",
    (_name, toolKey, band, locationId) => {
      expect(escalationPolicyFor(LINKS, { toolKey, band, locationId })).toEqual({
        status: "not_configured",
        toolKey,
        band,
      });
    },
  );

  it("never takes another location's policy", () => {
    const onlyHome = [link("home-only", { locationId: HOME })];
    expect(
      escalationPolicyFor(onlyHome, { toolKey: "news2", band: "high", locationId: LODGE }),
    ).toMatchObject({ status: "not_configured" });
  });
});

describe("hazard HZ-012 the link is the organisation's own policy, never a Harbour recommendation", () => {
  it("returns only what the organisation configured, and the band as stored", () => {
    const own = link("own", {
      title: "Deteriorating resident policy",
      reference: "CP-12 v3",
      documentId: "0194d000-0000-7000-8000-00000000d001",
    });
    const resolved = escalationPolicyFor([own], {
      toolKey: "news2",
      band: "low_medium",
      locationId: HOME,
    });
    expect(resolved).toEqual({
      status: "configured",
      toolKey: "news2",
      band: "low_medium",
      link: own,
      matchedOn: "tool",
      scope: "organisation",
    });
  });

  it("lists every band each tool's results carry, and none for the falls pathway", () => {
    const news2: Record<News2Band, true> = {
      low: true,
      low_medium: true,
      medium: true,
      high: true,
    };
    const must: Record<MustBand, true> = { low: true, medium: true, high: true };
    const waterlow: Record<WaterlowBand, true> = {
      not_at_risk: true,
      at_risk: true,
      high_risk: true,
      very_high_risk: true,
    };
    const braden: Record<BradenBand, true> = {
      severe_risk: true,
      high_risk: true,
      moderate_risk: true,
      at_risk: true,
      below_at_risk_threshold: true,
    };
    expect([...ESCALATION_POLICY_BANDS.news2].sort()).toEqual(Object.keys(news2).sort());
    expect([...ESCALATION_POLICY_BANDS.must].sort()).toEqual(Object.keys(must).sort());
    expect([...ESCALATION_POLICY_BANDS.waterlow].sort()).toEqual(Object.keys(waterlow).sort());
    expect([...ESCALATION_POLICY_BANDS.braden].sort()).toEqual(Object.keys(braden).sort());
    expect(ESCALATION_POLICY_BANDS.ng249_falls).toEqual([]);
    expect([...ESCALATION_POLICY_TOOLS].sort()).toEqual(
      Object.keys(ESCALATION_POLICY_BANDS).sort(),
    );
  });
});

describe("hazard HZ-014 a policy link is checked before it is saved", () => {
  it.each([
    ["NEWS2 for every band", { toolKey: "news2", band: null }, true],
    ["NEWS2 high", { toolKey: "news2", band: "high" }, true],
    ["Braden below the threshold", { toolKey: "braden", band: "below_at_risk_threshold" }, true],
    ["the falls pathway", { toolKey: "ng249_falls", band: null }, true],
    ["a tool Harbour does not calculate", { toolKey: "abbey", band: null }, false],
    ["another tool's band", { toolKey: "must", band: "very_high_risk" }, false],
    ["a band for the falls pathway", { toolKey: "ng249_falls", band: "high" }, false],
  ] as const)("%s", (_name, input, ok) => {
    expect(
      checkEscalationPolicyLink({ ...input, title: "Deterioration policy", reference: null }).ok,
    ).toBe(ok);
  });

  it.each([
    ["too short", "Po", "title"],
    ["too long", "P".repeat(201), "title"],
    ["with a control character", "Policy\u0007", "title"],
  ] as const)("refuses a title %s", (_name, title, field) => {
    expect(
      checkEscalationPolicyLink({ toolKey: "news2", band: null, title, reference: null }),
    ).toMatchObject({ ok: false, field });
  });

  it("refuses a reference over 100 characters", () => {
    expect(
      checkEscalationPolicyLink({
        toolKey: "news2",
        band: null,
        title: "Deterioration policy",
        reference: "R".repeat(101),
      }),
    ).toMatchObject({ ok: false, field: "reference" });
  });
});

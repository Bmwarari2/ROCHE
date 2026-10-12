/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tablePlatformRates } from "../../test/rate-table";
import { type EffectiveAccess, resolveAccess } from "./access";
import {
  checkDpiaSignOff,
  checkFeatureEnable,
  type DpiaBasis,
  type DpiaConfig,
  type DpiaSignOffInput,
  type DpiaState,
  type DpiaView,
  dpiaBasis,
  dpiaReviewDueAt,
  dpiaReviewTriggers,
  dpiaState,
  prefillDpia,
  type RiskLevel,
} from "./dpia";
import type { FlagKey } from "./feature-flags";
import { builtinRole } from "./roles";

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const RATES = tablePlatformRates();
const TEMPLATE = fileURLToPath(
  new URL("../../../../docs/compliance/dpia-template.md", import.meta.url),
);
const SHA = "c".repeat(64);

function accessFor(roleKey: string): EffectiveAccess {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(roleKey);
  return resolveAccess(
    [
      {
        roleKey,
        scopeKind: role.scopeKind,
        permissions: role.permissions,
        locationId: null,
        organisationWide: true,
        validFrom: PAST,
        validTo: null,
      },
    ],
    [],
    NOW,
  );
}

function config(
  extra: Partial<DpiaConfig> = {},
  features: FlagKey[] = ["module.residential"],
): DpiaConfig {
  return {
    tenant: {
      legalName: "Example Care Homes Ltd",
      regulator: "cqc",
      cqcProviderId: "1-000000001",
      sector: "independent",
      dpo: { name: "Ada Example", email: "dpo@example.invalid" },
      caldicottGuardian: "Bea Example",
      siro: "Cal Example",
      dpaSignedOn: "2026-10-01",
      privacyNoticeUrl: "https://care.example.invalid/privacy",
    },
    locations: [{ name: "Example House", regulatorLocationId: "1-000000002" }],
    serviceTypes: ["residential"],
    features,
    optional: { marketing: false, ai_free_text: false },
    capabilities: { mobilePush: false, sms: false },
    aiProvider: null,
    deviceModes: ["shared"],
    offlineWindowDays: 7,
    retention: { scheduleVersion: "2026-10-11", overrides: [] },
    stats: { activePeople: 40, activeStaff: 55 },
    ...extra,
  };
}

describe("DPIA prefill", () => {
  it("prefills the template's sections from the configuration", () => {
    const draft = prefillDpia(config(), NOW);
    expect(draft.sections.map((s) => s.key)).toEqual([
      "identification",
      "screening",
      "nature",
      "scope",
      "context",
      "purposes",
      "consultation",
      "necessity",
      "risks",
      "measures",
    ]);
    expect(draft.generatedAt).toBe("2026-10-11T10:00:00.000Z");
    expect(draft.sections[0]?.prefilled).toMatchObject({
      controller: "Example Care Homes Ltd",
      cqcProviderId: "1-000000001",
    });
    expect(draft.sections.find((s) => s.key === "purposes")?.prefilled).toEqual({
      purposes: ["B1", "B2", "B3", "B4", "B5", "B6", "B7"],
    });
    expect(draft.missingConfig).toEqual([]);
    expect(draft.risks.map((r) => r.id)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);
  });

  it("uses the template's risk ids and wording for every risk", () => {
    const template = readFileSync(TEMPLATE, "utf8");
    const everything = config(
      { aiProvider: "bedrock_london", optional: { marketing: true, ai_free_text: true } },
      ["module.domiciliary", "module.ai", "module.family_portal"],
    );
    const risks = prefillDpia(everything, NOW).risks;
    expect(risks.map((r) => r.id)).toEqual(Array.from({ length: 12 }, (_, i) => `R${i + 1}`));
    for (const risk of risks) expect(template).toContain(`| ${risk.id} | ${risk.risk}`);
  });

  it.each<[string, Partial<DpiaConfig>, FlagKey[], string[], string[]]>([
    [
      "AI on free text",
      { optional: { marketing: false, ai_free_text: true }, aiProvider: "bedrock_london" },
      ["module.ai"],
      ["ai_addendum"],
      ["R10"],
    ],
    [
      "AI without free text",
      { aiProvider: "bedrock_london" },
      ["module.ai"],
      ["ai_addendum"],
      ["R10"],
    ],
    ["family portal photos", {}, ["module.family_portal"], ["family_portal"], ["R11"]],
    [
      "marketing",
      { optional: { marketing: true, ai_free_text: false } },
      [],
      ["marketing"],
      ["R12"],
    ],
    ["home care monitoring", {}, ["module.domiciliary"], [], ["R9"]],
  ])("adds the sections and risks for %s", (_label, extra, features, sections, risks) => {
    const draft = prefillDpia(config(extra, features), NOW);
    const optional = draft.sections.map((s) => s.key).slice(10);
    expect(optional).toEqual(sections);
    expect(draft.risks.map((r) => r.id).slice(8)).toEqual(risks);
  });

  it("screens for monitoring, AI and children from the configuration", () => {
    const draft = prefillDpia(
      config({ serviceTypes: ["childrens_home"], aiProvider: "bedrock_london" }, [
        "module.domiciliary",
        "module.ai",
      ]),
      NOW,
    );
    expect(draft.sections.find((s) => s.key === "screening")?.prefilled).toMatchObject({
      systematicMonitoring: true,
      aiProcessing: true,
      childrensData: true,
    });
  });

  it.each<[string, Partial<DpiaConfig["tenant"]>, Partial<DpiaConfig>, FlagKey[], string]>([
    ["no legal name", { legalName: null }, {}, [], "tenant.legalName"],
    [
      "no CQC provider ID for a CQC provider",
      { cqcProviderId: null },
      {},
      [],
      "tenant.cqcProviderId",
    ],
    ["no DPO", { dpo: null }, {}, [], "tenant.dpo"],
    ["no signed DPA", { dpaSignedOn: null }, {}, [], "tenant.dpaSignedOn"],
    ["no privacy notice", { privacyNoticeUrl: null }, {}, [], "tenant.privacyNoticeUrl"],
    ["no locations", {}, { locations: [] }, [], "locations"],
    ["AI with no provider", {}, {}, ["module.ai"], "ai.provider"],
  ])("lists what is missing: %s", (_label, tenant, extra, features, missing) => {
    const base = config(extra, features);
    const draft = prefillDpia({ ...base, tenant: { ...base.tenant, ...tenant } }, NOW);
    expect(draft.missingConfig).toContain(missing);
  });

  it("does not ask a provider regulated outside CQC for a CQC provider ID", () => {
    const base = config();
    const draft = prefillDpia(
      { ...base, tenant: { ...base.tenant, regulator: "other", cqcProviderId: null } },
      NOW,
    );
    expect(draft.missingConfig).toEqual([]);
  });
});

describe("DPIA sign-off by the data protection lead, not a preparer", () => {
  const draft = prefillDpia(config(), NOW);
  const allFields = Object.fromEntries(draft.sections.map((s) => [s.key, s.tenantFields]));
  const rated = (level: RiskLevel = "low") =>
    Object.fromEntries(draft.risks.map((r) => [r.id, level]));
  const input = (extra: Partial<DpiaSignOffInput> = {}): DpiaSignOffInput => ({
    draft,
    status: "prepared",
    preparedBy: ["rm-1"],
    completedFields: allFields,
    residualRisk: rated(),
    icoConsultationReference: null,
    versionSha256: SHA,
    actor: { tenantUserId: "ql-1", access: accessFor("quality_lead") },
    lastMfaSignInAt: new Date(NOW.getTime() - 60_000),
    now: NOW,
    stepUpWindowSeconds: 600,
    designatedLeadIds: ["ql-1"],
    signature: { typedName: "Ada Example", sha256Seen: SHA },
    ...extra,
  });

  it("signs a complete, prepared DPIA", () => {
    expect(checkDpiaSignOff(input())).toMatchObject({
      ok: true,
      signerName: "Ada Example",
      basis: draft.basis,
    });
  });

  it("lets the owner sign when the owner is the named lead and did not prepare it", () => {
    const result = checkDpiaSignOff(
      input({
        actor: { tenantUserId: "owner-1", access: accessFor("owner") },
        designatedLeadIds: ["owner-1"],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a high residual risk once the ICO has been consulted", () => {
    const residualRisk = { ...rated(), R4: "high" as const };
    expect(
      checkDpiaSignOff(input({ residualRisk, icoConsultationReference: "ICO-EXAMPLE-1" })).ok,
    ).toBe(true);
  });

  it.each<[string, Partial<DpiaSignOffInput>, string]>([
    ["a draft", { status: "draft" }, "not_prepared"],
    [
      "an old MFA sign-in",
      { lastMfaSignInAt: new Date(NOW.getTime() - 3_600_000) },
      "step_up_required",
    ],
    ["no MFA sign-in", { lastMfaSignInAt: null }, "step_up_required"],
    ["an already signed version", { status: "signed" }, "not_prepared"],
    [
      "a Registered Manager",
      { actor: { tenantUserId: "ql-1", access: accessFor("registered_manager") } },
      "missing_permission",
    ],
    [
      "a quality lead who is not the named lead",
      { designatedLeadIds: ["someone-else"] },
      "not_designated_lead",
    ],
    ["the lead who helped prepare it", { preparedBy: ["rm-1", "ql-1"] }, "preparer_cannot_sign"],
    [
      "missing organisation details",
      { draft: prefillDpia({ ...config(), tenant: { ...config().tenant, dpo: null } }, NOW) },
      "config_missing",
    ],
    [
      "an unanswered section",
      { completedFields: { ...allFields, consultation: ["staff"] } },
      "section_incomplete",
    ],
    ["an unrated risk", { residualRisk: { ...rated(), R3: null } }, "residual_not_rated"],
    [
      "a high residual risk without the ICO",
      { residualRisk: { ...rated(), R4: "high" } },
      "high_residual_without_ico",
    ],
    [
      "a blank ICO reference",
      { residualRisk: { ...rated(), R4: "high" }, icoConsultationReference: "  " },
      "high_residual_without_ico",
    ],
    [
      "a version changed since it was read",
      { signature: { typedName: "Ada Example", sha256Seen: "d".repeat(64) } },
      "document_changed",
    ],
    ["no typed name", { signature: { typedName: " ", sha256Seen: SHA } }, "name_required"],
  ])("refuses %s", (_label, extra, problem) => {
    const result = checkDpiaSignOff(input(extra));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((i) => i.problem)).toContain(problem);
  });

  it("names the incomplete fields and unrated risks", () => {
    const result = checkDpiaSignOff(
      input({
        completedFields: { ...allFields, consultation: ["staff"] },
        residualRisk: { ...rated(), R2: null },
      }),
    );
    if (result.ok) throw new Error("expected problems");
    expect(result.issues.find((i) => i.problem === "section_incomplete")?.detail).toEqual([
      "consultation.people_receiving_care",
      "consultation.dpo_and_caldicott_guardian",
      "consultation.clinical_lead",
    ]);
    expect(result.issues.find((i) => i.problem === "residual_not_rated")?.detail).toEqual(["R2"]);
  });

  it("returns every problem at once", () => {
    const result = checkDpiaSignOff(
      input({ status: "draft", preparedBy: ["ql-1"], designatedLeadIds: [], residualRisk: {} }),
    );
    if (result.ok) throw new Error("expected problems");
    expect(result.issues.map((i) => i.problem)).toEqual([
      "not_prepared",
      "not_designated_lead",
      "preparer_cannot_sign",
      "residual_not_rated",
    ]);
  });
});

describe("DPIA re-review", () => {
  const signedAt = new Date("2026-03-15T12:00:00Z");
  const basis = dpiaBasis(config());
  const signed = { signedAt, basis };
  const soon = new Date("2026-06-01T09:00:00Z");

  it("falls due the rate-table number of months after sign-off, in UK time", () => {
    const due = dpiaReviewDueAt(signedAt, RATES);
    expect(RATES.dpiaReviewIntervalMonths).toBe(12);
    // 12:00 GMT on 15 March 2026 is 12:00 GMT on 15 March 2027.
    expect(due.toISOString()).toBe("2027-03-15T12:00:00.000Z");
    expect(dpiaReviewDueAt(new Date("2028-02-29T10:00:00Z"), RATES).toISOString()).toBe(
      "2029-02-28T10:00:00.000Z",
    );
  });

  it("needs no review when nothing has changed within the year", () => {
    expect(dpiaReviewTriggers(signed, basis, soon, RATES)).toEqual([]);
  });

  it.each<[string, DpiaBasis, string[]]>([
    [
      "the family portal switched on",
      dpiaBasis(config({}, ["module.residential", "module.family_portal"])),
      ["new_purpose", "new_data_category", "feature_enabled"],
    ],
    [
      "mobile push switched on",
      dpiaBasis(config({ capabilities: { mobilePush: true, sms: false } })),
      ["new_sub_processor"],
    ],
    [
      "marketing switched on",
      dpiaBasis(config({ optional: { marketing: true, ai_free_text: false } })),
      ["new_purpose", "new_data_category"],
    ],
    [
      "eMAR switched on",
      dpiaBasis(config({}, ["module.residential", "module.emar"])),
      ["new_data_category", "feature_enabled"],
    ],
    ["a module switched off", dpiaBasis(config({}, [])), []],
  ])("triggers a review when %s", (_label, current, kinds) => {
    expect(dpiaReviewTriggers(signed, current, soon, RATES).map((t) => t.kind)).toEqual(kinds);
  });

  it("names what is new", () => {
    const current = dpiaBasis(config({ capabilities: { mobilePush: true, sms: true } }));
    expect(dpiaReviewTriggers(signed, current, soon, RATES)).toEqual([
      { kind: "new_sub_processor", items: ["apns_fcm", "expo_push", "uk_sms_gateway"] },
    ]);
  });

  it("asks for the yearly review on the due date, not a minute before", () => {
    const due = dpiaReviewDueAt(signedAt, RATES);
    expect(dpiaReviewTriggers(signed, basis, new Date(due.getTime() - 60_000), RATES)).toEqual([]);
    expect(dpiaReviewTriggers(signed, basis, due, RATES)).toEqual([
      { kind: "yearly_review", dueAt: due },
    ]);
  });

  const view = (
    status: DpiaView["status"],
    at: Date | null = null,
    b: DpiaBasis | null = null,
  ): DpiaView => ({
    status,
    signedAt: at,
    basis: b,
  });
  it.each<[string, DpiaView | null, DpiaView | null, DpiaState]>([
    ["nothing started", null, null, "not_started"],
    ["a draft", null, view("draft"), "draft"],
    ["ready for sign-off", null, view("prepared"), "prepared"],
    ["signed and current", view("signed", signedAt, basis), null, "signed"],
    [
      "signed, with a new draft being prepared",
      view("signed", signedAt, basis),
      view("draft"),
      "signed",
    ],
    ["signed but superseded", view("superseded", signedAt, basis), view("draft"), "draft"],
  ])("state: %s", (_label, latestSigned, latestDraft, state) => {
    expect(dpiaState(latestSigned, latestDraft, basis, soon, RATES)).toMatchObject({ state });
  });

  it("is due for review when the processing has changed since sign-off", () => {
    const current = dpiaBasis(config({}, ["module.residential", "module.finance"]));
    const result = dpiaState(view("signed", signedAt, basis), null, current, soon, RATES);
    expect(result.state).toBe("review_due");
    expect(result.triggers.map((t) => t.kind)).toEqual(["new_data_category", "feature_enabled"]);
  });
});

describe("switching a module on against the DPIA", () => {
  const withAi = dpiaBasis(
    config({ aiProvider: "bedrock_london" }, ["module.residential", "module.ai"]),
  );
  const without = dpiaBasis(config());

  it.each<[string, FlagKey, DpiaBasis | null, boolean, boolean]>([
    ["AI with no signed DPIA", "module.ai", null, false, false],
    ["AI when the signed DPIA does not cover it", "module.ai", without, false, false],
    ["AI once the signed DPIA covers it", "module.ai", withAi, true, false],
    ["finance, which flags a review", "module.finance", without, true, true],
    ["the Welsh interface, which changes no processing", "locale.welsh", without, true, false],
  ])("%s", (_label, flag, basis, ok, review) => {
    const result = checkFeatureEnable(flag, basis);
    expect(result.ok).toBe(ok);
    if (result.ok) expect(result.reviewTriggered).toBe(review);
    else expect(result.problem).toBe("dpia_addendum_required");
  });
});

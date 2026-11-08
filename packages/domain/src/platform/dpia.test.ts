/// <reference types="node" />
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tablePlatformRates } from "../../test/rate-table";
import { type EffectiveAccess, resolveAccess } from "./access";
import {
  checkDpiaSignOff,
  checkFeatureEnable,
  DPIA_MONITORING_FLAGS,
  type DpiaBasis,
  type DpiaConfig,
  type DpiaMonitoringFlag,
  type DpiaSignOffInput,
  type DpiaState,
  type DpiaView,
  dpiaBasis,
  dpiaReviewDueAt,
  dpiaReviewTriggers,
  dpiaState,
  monitoringCovered,
  prefillDpia,
  type RiskLevel,
  standardRiskIds,
} from "./dpia";
import type { FlagKey } from "./feature-flags";
import { builtinRole } from "./roles";

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const RATES = tablePlatformRates();
const TEMPLATE = fileURLToPath(
  new URL("../../../../docs/compliance/dpia-template.md", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SHA = "c".repeat(64);
/** The Phase 1 risks every tenant's DPIA carries, after any optional processing's own risk. */
const PHASE_1_RISK_IDS = ["R13", "R14", "R15", "R16", "R17", "R18", "R19"];
/** The Phase 2 risks every tenant's DPIA carries, after the Phase 1 risks (plan slice 84). */
const PHASE_2_RISK_IDS = ["R20", "R21", "R22", "R23", "R24", "R25", "R26", "R27", "R28", "R29"];
const STANDARD_AFTER_OPTIONAL = [...PHASE_1_RISK_IDS, ...PHASE_2_RISK_IDS];

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
      purposes: ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B14", "B16"],
    });
    expect(draft.missingConfig).toEqual([]);
    expect(draft.risks.map((r) => r.id)).toEqual([
      ...["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
      ...STANDARD_AFTER_OPTIONAL,
    ]);
  });

  it("uses the template's risk ids and wording for every risk", () => {
    const template = readFileSync(TEMPLATE, "utf8");
    const everything = config(
      { aiProvider: "bedrock_london", optional: { marketing: true, ai_free_text: true } },
      ["module.domiciliary", "module.ai", "module.family_portal"],
    );
    const risks = prefillDpia(everything, NOW).risks;
    expect(risks.map((r) => r.id)).toEqual(Array.from({ length: 29 }, (_, i) => `R${i + 1}`));
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
    expect(draft.risks.map((r) => r.id).slice(8, -STANDARD_AFTER_OPTIONAL.length)).toEqual(risks);
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

/** The template's text from one heading up to the next heading of the same or a higher level. */
function templateSection(template: string, heading: string): string {
  const start = template.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.split(" ")[0] ?? "";
  const rest = template.slice(start + heading.length + 1);
  const next = rest.search(new RegExp(`^#{1,${level.length}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

/** The cells of the table row that starts with `| <id> |`, trimmed. */
function rowCells(section: string, id: string): string[] {
  const line = section.split("\n").find((l) => l.startsWith(`| ${id} | `));
  if (!line) throw new Error(`no row ${id}`);
  return line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

describe("Phase 2 risks R20 to R29 (dpia-template.md sections 6, 7 and 7B)", () => {
  const template = readFileSync(TEMPLATE, "utf8");
  const section6 = templateSection(template, "## 6. Risks to individuals");
  const section7 = templateSection(template, "## 7. Measures to reduce risk");
  const section7B = templateSection(
    template,
    "## 7B. Phase 2 processing: workforce, rights and safety (draft)",
  );
  const mapping = templateSection(template, "### 7B.2 Which risks apply to which processing");
  const risks = prefillDpia(config(), NOW).risks;
  const capital = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

  it("puts every Phase 2 risk in every tenant's prefill, after the Phase 1 risks", () => {
    expect(risks.map((r) => r.id).slice(-PHASE_2_RISK_IDS.length)).toEqual(PHASE_2_RISK_IDS);
    expect(standardRiskIds().slice(-PHASE_2_RISK_IDS.length)).toEqual(PHASE_2_RISK_IDS);
  });

  it.each(PHASE_2_RISK_IDS)("%s carries a likelihood, severity and overall rating", (id) => {
    const risk = risks.find((r) => r.id === id);
    expect(risk).toBeDefined();
    expect(["remote", "possible", "probable"]).toContain(risk?.likelihood);
    expect(["minimal", "significant", "severe"]).toContain(risk?.severity);
    expect(["low", "medium", "high"]).toContain(risk?.overall);
  });

  it.each(PHASE_2_RISK_IDS)("%s matches its section 6 row word for word", (id) => {
    const risk = risks.find((r) => r.id === id);
    if (!risk) throw new Error(id);
    expect(rowCells(section6, id)).toEqual([
      id,
      risk.risk,
      capital(risk.likelihood),
      capital(risk.severity),
      capital(risk.overall),
    ]);
  });

  it.each(PHASE_2_RISK_IDS)("%s has the same wording and initial rating in section 7B.3", (id) => {
    const risk = risks.find((r) => r.id === id);
    if (!risk) throw new Error(id);
    const detail = templateSection(template, `#### ${id} ${risk.risk}`);
    expect(detail).toContain(
      `| Initial | ${capital(risk.likelihood)}, ${risk.severity}, **${risk.overall}** |`,
    );
    for (const field of ["Slices", "Measures built (evidence)", "Expected residual", "DPO decides"])
      expect(detail).toContain(`| ${field} | `);
  });

  it.each(PHASE_2_RISK_IDS)("%s has measures in section 7 and processing in section 7B.2", (id) => {
    const [, measures, , effect] = rowCells(section7, id);
    expect(measures).toContain("section 7B");
    expect(effect).toBe("Reduced");
    expect(mapping).toMatch(new RegExp(`\\b${id}\\b`));
  });

  it("names only evidence that exists on this branch, never a feature branch", () => {
    expect(section7B).not.toMatch(/\b(feat|fix|chore|docs)\/[a-z0-9-]+/);
    expect(section7B).toContain("Status: draft for the DPO, not signed and not approved.");
    const paths = [
      ...section7B.matchAll(/`((?:apps|packages|docs)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|sql|md))`/g),
    ].map((m) => m[1] ?? "");
    expect(paths.length).toBeGreaterThan(20);
    expect(paths.filter((p) => !existsSync(`${REPO_ROOT}${p}`))).toEqual([]);
  });

  it.each(PHASE_2_RISK_IDS)("refuses sign-off while %s has no residual rating", (id) => {
    const draft = prefillDpia(config(), NOW);
    const residualRisk = Object.fromEntries(
      draft.risks.map((r) => [r.id, r.id === id ? null : ("low" as const)]),
    );
    const result = checkDpiaSignOff({
      draft,
      status: "prepared",
      preparedBy: ["rm-1"],
      completedFields: Object.fromEntries(draft.sections.map((s) => [s.key, s.tenantFields])),
      residualRisk,
      icoConsultationReference: null,
      versionSha256: SHA,
      actor: { tenantUserId: "ql-1", access: accessFor("quality_lead") },
      stepUpAt: new Date(NOW.getTime() - 60_000),
      now: NOW,
      stepUpWindowSeconds: 600,
      designatedLeadIds: ["ql-1"],
      signature: { typedName: "Ada Example", sha256Seen: SHA },
    });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.issues).toEqual([
      expect.objectContaining({ problem: "residual_not_rated", detail: [id] }),
    ]);
  });

  const signedAt = new Date("2026-03-15T12:00:00Z");
  const soon = new Date("2026-06-01T09:00:00Z");
  const current = dpiaBasis(config());
  it.each<[string, readonly string[] | undefined, string[]]>([
    ["before standard risks were recorded", undefined, [...PHASE_1_RISK_IDS, ...PHASE_2_RISK_IDS]],
    [
      "with the base and Phase 1 risks only",
      standardRiskIds().filter((id) => !PHASE_2_RISK_IDS.includes(id)),
      PHASE_2_RISK_IDS,
    ],
    [
      "with R20 to R24 only of Phase 2",
      standardRiskIds().filter((id) => !["R25", "R26", "R27", "R28", "R29"].includes(id)),
      ["R25", "R26", "R27", "R28", "R29"],
    ],
    ["with every standard risk", standardRiskIds(), []],
  ])("flags a DPIA signed %s for the risks it never assessed", (_label, standardRisks, items) => {
    const { standardRisks: _left, ...rest } = current;
    const signed: DpiaBasis = standardRisks === undefined ? rest : { ...rest, standardRisks };
    const triggers = dpiaReviewTriggers({ signedAt, basis: signed }, current, soon, RATES);
    expect(triggers).toEqual(items.length > 0 ? [{ kind: "new_standard_risk", items }] : []);
    const state = dpiaState(
      { status: "signed", signedAt, basis: signed },
      { status: "draft", signedAt: null, basis: null },
      current,
      soon,
      RATES,
    );
    expect(state.state).toBe(items.length > 0 ? "review_due" : "signed");
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
    stepUpAt: new Date(NOW.getTime() - 60_000),
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
    ["an old MFA sign-in", { stepUpAt: new Date(NOW.getTime() - 3_600_000) }, "step_up_required"],
    ["no MFA sign-in", { stepUpAt: null }, "step_up_required"],
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

  it("flags a DPIA signed before a standard risk was added, naming the new risks", () => {
    const beforePhase2 = {
      ...basis,
      standardRisks: standardRiskIds().filter((id) => !PHASE_2_RISK_IDS.includes(id)),
    };
    expect(dpiaReviewTriggers({ signedAt, basis: beforePhase2 }, basis, soon, RATES)).toEqual([
      { kind: "new_standard_risk", items: PHASE_2_RISK_IDS },
    ]);
  });

  it("treats a basis saved before standard risks were recorded as covering R1 to R8 only", () => {
    const { standardRisks: _left, ...older } = basis;
    expect(dpiaReviewTriggers({ signedAt, basis: older }, basis, soon, RATES)).toEqual([
      { kind: "new_standard_risk", items: [...PHASE_1_RISK_IDS, ...PHASE_2_RISK_IDS] },
    ]);
    const result = dpiaState(view("signed", signedAt, older), null, basis, soon, RATES);
    expect(result.state).toBe("review_due");
  });

  it("records every standard risk in the basis, and never a conditional one", () => {
    expect(basis.standardRisks).toEqual([
      ...["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
      ...STANDARD_AFTER_OPTIONAL,
    ]);
    const withAi = dpiaBasis(
      config({ aiProvider: "bedrock_london" }, ["module.residential", "module.ai"]),
    );
    expect(withAi.standardRisks).not.toContain("R10");
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

describe("employee monitoring under the signed DPIA (H-527, H-1033, H-1555)", () => {
  const LONE = "scheduling.lone_worker.location" satisfies FlagKey;
  const CLOCK = "scheduling.clock.location_evidence" satisfies FlagKey;
  const signedAt = new Date("2026-03-15T12:00:00Z");
  const soon = new Date("2026-06-01T09:00:00Z");
  const without = dpiaBasis(config());
  const withLone = dpiaBasis(config({}, ["module.residential", LONE]));
  const withBoth = dpiaBasis(config({}, ["module.residential", LONE, CLOCK]));

  it("lists exactly the two monitoring flags", () => {
    expect([...DPIA_MONITORING_FLAGS]).toEqual([LONE, CLOCK]);
  });

  it.each<[string, FlagKey[], string[]]>([
    ["no monitoring", ["module.residential"], ["module.residential"]],
    ["lone-worker location", ["module.residential", LONE], ["module.residential", LONE]],
    ["clock evidence", ["module.residential", CLOCK], ["module.residential", CLOCK]],
    ["both", [CLOCK, LONE, "module.residential"], ["module.residential", CLOCK, LONE]],
    [
      "a flag that changes no processing",
      ["module.residential", "locale.welsh"],
      ["module.residential"],
    ],
  ])("counts the monitoring flags as features in the basis: %s", (_label, features, expected) => {
    expect(dpiaBasis(config({}, features)).features).toEqual(expected);
  });

  it("screens a monitoring flag as systematic monitoring", () => {
    const draft = prefillDpia(config({}, ["module.residential", CLOCK]), NOW);
    expect(draft.sections.find((s) => s.key === "screening")?.prefilled).toMatchObject({
      systematicMonitoring: true,
    });
  });

  it.each<[string, DpiaMonitoringFlag, DpiaBasis | null, boolean]>([
    ["lone-worker location with no signed DPIA", LONE, null, false],
    ["clock evidence with no signed DPIA", CLOCK, null, false],
    ["lone-worker location when the signed DPIA does not list it", LONE, without, false],
    ["clock evidence when the signed DPIA lists only lone-worker location", CLOCK, withLone, false],
    ["lone-worker location when the signed DPIA lists it", LONE, withLone, true],
    ["clock evidence when the signed DPIA lists it", CLOCK, withBoth, true],
  ])("covers %s: %s", (_label, flag, basis, covered) => {
    expect(monitoringCovered(flag, basis)).toBe(covered);
  });

  it.each<[string, DpiaBasis, DpiaBasis, string[] | null]>([
    ["lone-worker location switched on after signing", without, withLone, [LONE]],
    ["clock evidence switched on after signing", withLone, withBoth, [CLOCK]],
    ["both switched on after signing", without, withBoth, [CLOCK, LONE]],
    ["monitoring already covered when signed", withBoth, withBoth, null],
    ["monitoring switched off", withBoth, without, null],
  ])("flags the DPIA for review: %s", (_label, signedBasis, current, items) => {
    const triggers = dpiaReviewTriggers({ signedAt, basis: signedBasis }, current, soon, RATES);
    expect(triggers).toEqual(items ? [{ kind: "feature_enabled", items }] : []);
    expect(
      dpiaState({ status: "signed", signedAt, basis: signedBasis }, null, current, soon, RATES)
        .state,
    ).toBe(items ? "review_due" : "signed");
  });

  it.each<[string, FlagKey, boolean]>([
    ["lone-worker location", LONE, true],
    ["clock evidence", CLOCK, true],
  ])(
    "is never refused when a monitoring flag is switched on, and flags a review: %s",
    (_l, flag, review) => {
      const result = checkFeatureEnable(flag, without);
      expect(result).toEqual({ ok: true, reviewTriggered: review });
      expect(checkFeatureEnable(flag, withBoth)).toEqual({ ok: true, reviewTriggered: false });
    },
  );
});

import { addUkMonths } from "../shared/time";
import { can, type EffectiveAccess } from "./access";
import { checkSignature, type SignatureProblem } from "./documents";
import type { FlagKey } from "./feature-flags";
import {
  type ControllerSector,
  type OptionalProcessingSetting,
  type RegisterRow,
  recordsOfProcessingRegister,
  tenantDataCategories,
} from "./processing-register";
import type { PlatformRates } from "./rates";
import { DUTY_RULE_MESSAGES } from "./separation-of-duties";
import { type AiProvider, subProcessorsInUse } from "./sub-processors";

/**
 * Data protection impact assessment (UK GDPR Art 35 and 36; master prompt section 5.1;
 * docs/compliance/dpia-template.md; platform-completions.md rules 17 to 22). Harbour prefills each
 * tenant's DPIA from its configuration and records of processing; optional processing (AI on free
 * text, family portal photos, marketing) adds its own section. The tenant's designated data
 * protection officer or named lead signs it in-app before go-live, and cannot be one of the people
 * who prepared it. A signed DPIA is flagged for re-review when the processing changes (a purpose,
 * sub-processor, data category or feature it did not cover) and yearly (`dpia.review_interval_months`).
 */

/** What a signed DPIA covered; compared with the current configuration to find what is new. */
export interface DpiaBasis {
  readonly purposes: readonly string[];
  readonly subProcessors: readonly string[];
  readonly dataCategories: readonly string[];
  readonly features: readonly string[];
}

export type DeviceMode = "personal" | "shared" | "kiosk";

export interface DpiaConfig {
  readonly tenant: {
    readonly legalName: string | null;
    readonly regulator: "cqc" | "other";
    readonly cqcProviderId: string | null;
    readonly sector: ControllerSector;
    readonly dpo: { readonly name: string; readonly email: string } | null;
    readonly caldicottGuardian: string | null;
    readonly siro: string | null;
    readonly dpaSignedOn: string | null;
    readonly privacyNoticeUrl: string | null;
  };
  readonly locations: readonly {
    readonly name: string;
    readonly regulatorLocationId: string | null;
  }[];
  readonly serviceTypes: readonly string[];
  /** Modules switched on, plus any the tenant plans to switch on (the AI addendum comes first). */
  readonly features: readonly FlagKey[];
  readonly optional: Readonly<Record<OptionalProcessingSetting, boolean>>;
  readonly capabilities: { readonly mobilePush: boolean; readonly sms: boolean };
  readonly aiProvider: AiProvider | null;
  readonly deviceModes: readonly DeviceMode[];
  /** `mobile.offline_window_days` for the tenant, resolved from the rate table. */
  readonly offlineWindowDays: number;
  readonly retention: { readonly scheduleVersion: string; readonly overrides: readonly string[] };
  readonly stats: { readonly activePeople: number; readonly activeStaff: number };
}

function processingConfig(config: DpiaConfig) {
  return { sector: config.tenant.sector, features: config.features, optional: config.optional };
}

/** The features a DPIA must cover: every module (the other flags change no processing). */
function dpiaFeatures(features: readonly FlagKey[]): string[] {
  return [...new Set(features.filter((f) => f.startsWith("module.")))].sort();
}

export function dpiaBasis(config: DpiaConfig): DpiaBasis {
  return {
    purposes: recordsOfProcessingRegister(processingConfig(config)).map((r) => r.id),
    subProcessors: subProcessorsInUse(config).sort(),
    dataCategories: tenantDataCategories(processingConfig(config)),
    features: dpiaFeatures(config.features),
  };
}

// ------------------------------------------------------------------------------------------------
// Prefill
// ------------------------------------------------------------------------------------------------

export const DPIA_SECTION_KEYS = [
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
  "ai_addendum",
  "family_portal",
  "marketing",
] as const;
export type DpiaSectionKey = (typeof DPIA_SECTION_KEYS)[number];

export interface DpiaSection {
  readonly key: DpiaSectionKey;
  readonly title: string;
  /** Values Harbour fills from the configuration. */
  readonly prefilled: Readonly<Record<string, unknown>>;
  /** Fields the tenant must complete before sign-off. */
  readonly tenantFields: readonly string[];
}

export type RiskLevel = "low" | "medium" | "high";

export interface DpiaRisk {
  readonly id: string;
  readonly risk: string;
  readonly likelihood: "remote" | "possible" | "probable";
  readonly severity: "minimal" | "significant" | "severe";
  readonly overall: RiskLevel;
}

/** The template's risks (section 6), with the optional processing's own risks. */
const BASE_RISKS: readonly DpiaRisk[] = [
  {
    id: "R1",
    risk: "Unauthorised access by staff outside their role or scope",
    likelihood: "possible",
    severity: "significant",
    overall: "medium",
  },
  {
    id: "R2",
    risk: "Loss or theft of a device holding offline records",
    likelihood: "possible",
    severity: "significant",
    overall: "medium",
  },
  {
    id: "R3",
    risk: "Exposure to another provider's users (cross-tenant)",
    likelihood: "remote",
    severity: "severe",
    overall: "medium",
  },
  {
    id: "R4",
    risk: "Inaccurate or out-of-date records leading to wrong care",
    likelihood: "possible",
    severity: "severe",
    overall: "high",
  },
  {
    id: "R5",
    risk: "Records kept longer than necessary, or deleted too early",
    likelihood: "possible",
    severity: "significant",
    overall: "medium",
  },
  {
    id: "R6",
    risk: "Sharing with families or professionals beyond what is agreed",
    likelihood: "possible",
    severity: "significant",
    overall: "medium",
  },
  {
    id: "R7",
    risk: "Transfer outside the UK through a sub-processor",
    likelihood: "remote",
    severity: "significant",
    overall: "low",
  },
  {
    id: "R8",
    risk: "Shared-device misuse (another user's session)",
    likelihood: "possible",
    severity: "significant",
    overall: "medium",
  },
];
const CONDITIONAL_RISKS: readonly {
  readonly when: (c: DpiaConfig) => boolean;
  readonly risk: DpiaRisk;
}[] = [
  {
    when: (c) => c.features.includes("module.domiciliary"),
    risk: {
      id: "R9",
      risk: "Location data from electronic call monitoring used beyond its purpose",
      likelihood: "possible",
      severity: "significant",
      overall: "medium",
    },
  },
  {
    when: (c) => c.features.includes("module.ai"),
    risk: {
      id: "R10",
      risk: "AI drafts relied on without review, prompt injection through notes, or disclosure to the provider",
      likelihood: "possible",
      severity: "significant",
      overall: "medium",
    },
  },
  {
    when: (c) => c.features.includes("module.family_portal"),
    risk: {
      id: "R11",
      risk: "A photo or update shared beyond the consent given",
      likelihood: "possible",
      severity: "significant",
      overall: "medium",
    },
  },
  {
    when: (c) => c.optional.marketing,
    risk: {
      id: "R12",
      risk: "Marketing without valid consent",
      likelihood: "possible",
      severity: "minimal",
      overall: "low",
    },
  },
];

export interface DpiaDraft {
  readonly generatedAt: string;
  readonly basis: DpiaBasis;
  readonly sections: readonly DpiaSection[];
  readonly purposes: readonly RegisterRow[];
  readonly risks: readonly DpiaRisk[];
  /** Configuration Harbour needs before the DPIA can be signed (shown as tasks). */
  readonly missingConfig: readonly string[];
}

function missingConfig(config: DpiaConfig): string[] {
  const t = config.tenant;
  const missing: string[] = [];
  if (!t.legalName) missing.push("tenant.legalName");
  if (t.regulator === "cqc" && !t.cqcProviderId) missing.push("tenant.cqcProviderId");
  if (!t.dpo) missing.push("tenant.dpo");
  if (!t.dpaSignedOn) missing.push("tenant.dpaSignedOn");
  if (!t.privacyNoticeUrl) missing.push("tenant.privacyNoticeUrl");
  if (config.locations.length === 0) missing.push("locations");
  if (config.features.includes("module.ai") && !config.aiProvider) missing.push("ai.provider");
  return missing;
}

/**
 * Prefills the DPIA from the tenant's configuration (dpia-template.md sections 1 to 7 and 9).
 * The optional sections appear only when their processing is switched on or planned.
 */
export function prefillDpia(config: DpiaConfig, generatedAt: Date): DpiaDraft {
  const basis = dpiaBasis(config);
  const purposes = recordsOfProcessingRegister(processingConfig(config));
  const has = (flag: FlagKey) => config.features.includes(flag);
  const sections: DpiaSection[] = [
    {
      key: "identification",
      title: "Identification",
      prefilled: {
        controller: config.tenant.legalName,
        cqcProviderId: config.tenant.cqcProviderId,
        dpo: config.tenant.dpo,
        caldicottGuardian: config.tenant.caldicottGuardian,
        siro: config.tenant.siro,
        processor: "Thapsus Cargo Ltd (Harbour)",
        dpaSignedOn: config.tenant.dpaSignedOn,
      },
      tenantFields: [],
    },
    {
      key: "screening",
      title: "Need for a DPIA",
      prefilled: {
        specialCategoryLargeScale: true,
        vulnerablePeople: true,
        newTechnology: true,
        systematicMonitoring: has("module.domiciliary"),
        aiProcessing: has("module.ai"),
        childrensData: config.serviceTypes.includes("childrens_home"),
      },
      tenantFields: [],
    },
    {
      key: "nature",
      title: "Nature of the processing",
      prefilled: {
        locations: config.locations,
        serviceTypes: config.serviceTypes,
        modules: basis.features,
        deviceModes: config.deviceModes,
        offlineWindowDays: config.offlineWindowDays,
        subProcessors: basis.subProcessors,
        retentionScheduleVersion: config.retention.scheduleVersion,
        retentionOverrides: config.retention.overrides,
      },
      tenantFields: [],
    },
    {
      key: "scope",
      title: "Scope",
      prefilled: {
        activePeople: config.stats.activePeople,
        activeStaff: config.stats.activeStaff,
        dataCategories: basis.dataCategories,
        outsideUk: basis.subProcessors.length > 0,
      },
      tenantFields: [],
    },
    {
      key: "context",
      title: "Context",
      prefilled: {},
      tenantFields: ["relationship_and_expectations", "capacity_and_control", "prior_concerns"],
    },
    {
      key: "purposes",
      title: "Purposes",
      prefilled: { purposes: purposes.map((p) => p.id) },
      tenantFields: [],
    },
    {
      key: "consultation",
      title: "Consultation",
      prefilled: {},
      tenantFields: [
        "people_receiving_care",
        "staff",
        "dpo_and_caldicott_guardian",
        "clinical_lead",
      ],
    },
    {
      key: "necessity",
      title: "Necessity and proportionality",
      prefilled: {
        lawfulBasis: purposes.map((p) => ({ id: p.id, basis: p.lawfulBasis, consent: p.consent })),
        privacyNoticeUrl: config.tenant.privacyNoticeUrl,
      },
      tenantFields: [],
    },
    {
      key: "risks",
      title: "Risks to individuals",
      prefilled: {},
      tenantFields: ["local_risks_considered"],
    },
    {
      key: "measures",
      title: "Measures to reduce risk",
      prefilled: {},
      tenantFields: ["tenant_measures"],
    },
  ];
  if (has("module.ai")) {
    sections.push({
      key: "ai_addendum",
      title: "AI addendum",
      prefilled: {
        provider: config.aiProvider,
        freeText: config.optional.ai_free_text,
        trainingOnTenantData: "Not permitted by any provider contract",
        humanControl: "Outputs are drafts; no workflow changes state on model output alone",
      },
      tenantFields: ["accountable_owner", "capabilities", "locations", "communication"],
    });
  }
  if (has("module.family_portal")) {
    sections.push({
      key: "family_portal",
      title: "Family portal photos and updates",
      prefilled: { purpose: "B8", basis: "Consent, recorded per person and per family member" },
      tenantFields: ["consent_process", "what_families_see"],
    });
  }
  if (config.optional.marketing) {
    sections.push({
      key: "marketing",
      title: "Marketing to families and enquirers",
      prefilled: { purpose: "B9", basis: "Consent, and PECR for electronic messages" },
      tenantFields: ["consent_wording", "channels"],
    });
  }
  return {
    generatedAt: generatedAt.toISOString(),
    basis,
    sections,
    purposes,
    risks: [...BASE_RISKS, ...CONDITIONAL_RISKS.filter((r) => r.when(config)).map((r) => r.risk)],
    missingConfig: missingConfig(config),
  };
}

// ------------------------------------------------------------------------------------------------
// Sign-off
// ------------------------------------------------------------------------------------------------

export type DpiaStatus = "draft" | "prepared" | "signed" | "superseded";

export type DpiaSignOffProblem =
  | "not_prepared"
  | "missing_permission"
  | "not_designated_lead"
  | "preparer_cannot_sign"
  | "config_missing"
  | "section_incomplete"
  | "residual_not_rated"
  | "high_residual_without_ico"
  | SignatureProblem;

export interface DpiaSignOffInput {
  readonly draft: DpiaDraft;
  readonly status: DpiaStatus;
  /** Everyone who wrote any part of this version. */
  readonly preparedBy: readonly string[];
  /** Tenant fields completed, by section. */
  readonly completedFields: Readonly<Partial<Record<DpiaSectionKey, readonly string[]>>>;
  /** Residual risk the tenant rated for each risk after its measures. */
  readonly residualRisk: Readonly<Record<string, RiskLevel | null>>;
  /** ICO prior consultation reference (Art 36), needed when a residual risk stays high. */
  readonly icoConsultationReference: string | null;
  readonly versionSha256: string;
  readonly actor: { readonly tenantUserId: string; readonly access: EffectiveAccess };
  /** The tenant's designated DPO or named data protection lead(s), from governance settings. */
  readonly designatedLeadIds: readonly string[];
  readonly signature: {
    readonly typedName: string;
    readonly statement?: string | null;
    readonly sha256Seen: string;
  };
}

export interface DpiaSignOffIssue {
  readonly problem: DpiaSignOffProblem;
  readonly message: string;
  readonly detail?: readonly string[];
}

export type DpiaSignOffCheck =
  | {
      readonly ok: true;
      readonly signerName: string;
      readonly statement: string;
      readonly basis: DpiaBasis;
    }
  | { readonly ok: false; readonly issues: readonly DpiaSignOffIssue[] };

const SIGN_OFF_MESSAGES: Record<Exclude<DpiaSignOffProblem, SignatureProblem>, string> = {
  not_prepared: "Mark the DPIA as ready for sign-off first.",
  missing_permission: "Only the data protection lead can sign the DPIA.",
  not_designated_lead:
    "Only the person named as the organisation's data protection officer or lead can sign the DPIA.",
  preparer_cannot_sign: DUTY_RULE_MESSAGES.dpia_sign_off,
  config_missing: "Some organisation details the DPIA needs are missing.",
  section_incomplete: "Some sections still need your answers.",
  residual_not_rated: "Rate the remaining risk for every risk after its measures.",
  high_residual_without_ico:
    "A risk stays high after its measures. Consult the ICO before going ahead (Article 36) and record the reference.",
};

/**
 * Checks a DPIA sign-off and returns every problem at once: the version must be prepared and
 * complete, every risk rated after its measures, any high residual risk referred to the ICO, the
 * signer the designated data protection lead holding `platform.dpia.sign` and not one of its
 * preparers, and the typed-name signature bound to the version read.
 */
export function checkDpiaSignOff(input: DpiaSignOffInput): DpiaSignOffCheck {
  const issues: DpiaSignOffIssue[] = [];
  const add = (
    problem: Exclude<DpiaSignOffProblem, SignatureProblem>,
    detail?: readonly string[],
  ) => issues.push({ problem, message: SIGN_OFF_MESSAGES[problem], ...(detail ? { detail } : {}) });

  if (input.status !== "prepared") add("not_prepared");
  if (!can(input.actor.access, "platform.dpia.sign")) add("missing_permission");
  if (!input.designatedLeadIds.includes(input.actor.tenantUserId)) add("not_designated_lead");
  if (input.preparedBy.includes(input.actor.tenantUserId)) add("preparer_cannot_sign");
  if (input.draft.missingConfig.length > 0) add("config_missing", input.draft.missingConfig);

  const incomplete = input.draft.sections.flatMap((section) => {
    const done = input.completedFields[section.key] ?? [];
    return section.tenantFields.filter((f) => !done.includes(f)).map((f) => `${section.key}.${f}`);
  });
  if (incomplete.length > 0) add("section_incomplete", incomplete);

  const unrated = input.draft.risks.filter((r) => !input.residualRisk[r.id]).map((r) => r.id);
  if (unrated.length > 0) add("residual_not_rated", unrated);
  const high = input.draft.risks
    .filter((r) => input.residualRisk[r.id] === "high")
    .map((r) => r.id);
  if (high.length > 0 && !input.icoConsultationReference?.trim())
    add("high_residual_without_ico", high);

  const signature = checkSignature({
    typedName: input.signature.typedName,
    statement: input.signature.statement ?? null,
    sha256Seen: input.signature.sha256Seen,
    currentSha256: input.versionSha256,
  });
  if (!signature.ok) issues.push({ problem: signature.problem, message: signature.message });

  if (issues.length > 0 || !signature.ok) return { ok: false, issues };
  return {
    ok: true,
    signerName: signature.signerName,
    statement: signature.statement,
    basis: input.draft.basis,
  };
}

// ------------------------------------------------------------------------------------------------
// Re-review
// ------------------------------------------------------------------------------------------------

export type DpiaReviewTrigger =
  | { readonly kind: "new_purpose"; readonly items: readonly string[] }
  | { readonly kind: "new_sub_processor"; readonly items: readonly string[] }
  | { readonly kind: "new_data_category"; readonly items: readonly string[] }
  | { readonly kind: "feature_enabled"; readonly items: readonly string[] }
  | { readonly kind: "yearly_review"; readonly dueAt: Date };

/** The yearly review date: the rate-table interval after sign-off, in UK calendar months. */
export function dpiaReviewDueAt(
  signedAt: Date,
  rates: Pick<PlatformRates, "dpiaReviewIntervalMonths">,
): Date {
  return addUkMonths(signedAt, rates.dpiaReviewIntervalMonths);
}

/** What has changed since the DPIA was signed. Removing processing never triggers a review. */
export function dpiaReviewTriggers(
  signed: { readonly signedAt: Date; readonly basis: DpiaBasis },
  current: DpiaBasis,
  now: Date,
  rates: Pick<PlatformRates, "dpiaReviewIntervalMonths">,
): DpiaReviewTrigger[] {
  const added = (before: readonly string[], after: readonly string[]) =>
    after.filter((x) => !before.includes(x));
  const triggers: DpiaReviewTrigger[] = [];
  const checks = [
    ["new_purpose", signed.basis.purposes, current.purposes],
    ["new_sub_processor", signed.basis.subProcessors, current.subProcessors],
    ["new_data_category", signed.basis.dataCategories, current.dataCategories],
    ["feature_enabled", signed.basis.features, current.features],
  ] as const;
  for (const [kind, before, after] of checks) {
    const items = added(before, after);
    if (items.length > 0) triggers.push({ kind, items });
  }
  const dueAt = dpiaReviewDueAt(signed.signedAt, rates);
  if (now.getTime() >= dueAt.getTime()) triggers.push({ kind: "yearly_review", dueAt });
  return triggers;
}

export type DpiaState = "not_started" | "draft" | "prepared" | "signed" | "review_due";

export interface DpiaView {
  readonly status: DpiaStatus;
  readonly signedAt: Date | null;
  readonly basis: DpiaBasis | null;
}

/** The tenant's DPIA state for the onboarding checklist and the settings screen. */
export function dpiaState(
  latestSigned: DpiaView | null,
  latestDraft: DpiaView | null,
  current: DpiaBasis,
  now: Date,
  rates: Pick<PlatformRates, "dpiaReviewIntervalMonths">,
): { readonly state: DpiaState; readonly triggers: readonly DpiaReviewTrigger[] } {
  if (latestSigned?.status === "signed" && latestSigned.signedAt && latestSigned.basis) {
    const triggers = dpiaReviewTriggers(
      { signedAt: latestSigned.signedAt, basis: latestSigned.basis },
      current,
      now,
      rates,
    );
    return { state: triggers.length > 0 ? "review_due" : "signed", triggers };
  }
  if (latestDraft?.status === "prepared") return { state: "prepared", triggers: [] };
  if (latestDraft?.status === "draft") return { state: "draft", triggers: [] };
  return { state: "not_started", triggers: [] };
}

/** Modules that may be switched on only after a signed DPIA covers them (master prompt 16). */
export const DPIA_GATED_FEATURES: readonly FlagKey[] = ["module.ai"];

export type FeatureEnableCheck =
  | { readonly ok: true; readonly reviewTriggered: boolean }
  | { readonly ok: false; readonly problem: "dpia_addendum_required"; readonly message: string };

/**
 * Switching a module on: the AI module needs a signed DPIA whose basis already covers it (the AI
 * addendum is signed first, from a prefill that lists it as planned); any other module may be
 * switched on and flags the DPIA for re-review.
 */
export function checkFeatureEnable(
  flag: FlagKey,
  signedBasis: DpiaBasis | null,
): FeatureEnableCheck {
  const covered = signedBasis?.features.includes(flag) ?? false;
  if (DPIA_GATED_FEATURES.includes(flag) && !covered) {
    return {
      ok: false,
      problem: "dpia_addendum_required",
      message: "Sign the DPIA with its AI addendum before switching the AI module on.",
    };
  }
  return { ok: true, reviewTriggered: flag.startsWith("module.") && !covered };
}

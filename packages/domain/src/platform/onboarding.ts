import { LIVE_PERSON_STATUSES, type PersonStatus } from "../people/lifecycle";
import type { DpiaReviewTrigger, DpiaState } from "./dpia";
import { type EscalationStep, validateChain } from "./notifications";

/**
 * Tenant onboarding checklist (master prompt section 9.1, "Help and onboarding";
 * platform-completions.md rules 26 to 28; clinical-risk-management-plan.md section 7). Every item
 * is worked out from the organisation's configuration and records, never from a box someone ticks,
 * so the list cannot say "done" while the state says otherwise. Each item gives its reason from the
 * same state and links an in-app guide. Items marked required must be done before go-live,
 * including the clinical ones: the DCB0160 assessment, escalation for validated tools and alerts,
 * shared devices enrolled, the clinical settings reviewed, and every person's safety-critical
 * facts recorded (hazards HZ-001, HZ-007, HZ-014, HZ-015, HZ-016, HZ-023, HZ-027).
 */

export const ONBOARDING_ITEMS = [
  {
    key: "locations_identified",
    title: "Locations have their regulator location ID and ODS code",
    requiredForGoLive: true,
    guide: "set-up-locations",
  },
  {
    key: "registered_managers",
    title: "Every location has a Registered Manager",
    requiredForGoLive: true,
    guide: "roles-and-access",
  },
  {
    key: "first_users_with_mfa",
    title: "Your first staff have joined, with a second sign-in step",
    requiredForGoLive: true,
    guide: "invite-staff",
  },
  {
    key: "shared_devices_enrolled",
    title: "Shared and kiosk devices are enrolled in device management",
    requiredForGoLive: true,
    guide: "shared-devices",
  },
  {
    key: "escalation_chains_set",
    title: "Escalation chains are set for urgent alerts",
    requiredForGoLive: true,
    guide: "escalation-chains",
  },
  {
    key: "escalation_policies_linked",
    title: "Each validated tool in use links your escalation policy",
    requiredForGoLive: true,
    guide: "escalation-policies",
  },
  {
    key: "clinical_settings_reviewed",
    title: "Clinical settings are reviewed by your clinical lead",
    requiredForGoLive: true,
    guide: "clinical-settings",
  },
  {
    key: "people_ready",
    title: "Every person has a photo and their safety-critical facts recorded",
    requiredForGoLive: true,
    guide: "person-readiness",
  },
  {
    key: "rates_reviewed",
    title: "Other settings Harbour chose for you are reviewed",
    requiredForGoLive: false,
    guide: "review-settings",
  },
  {
    key: "retention_reviewed",
    title: "How long records are kept is reviewed",
    requiredForGoLive: true,
    guide: "retention",
  },
  {
    key: "dcb0160_recorded",
    title: "Your DCB0160 clinical safety assessment is recorded",
    requiredForGoLive: true,
    guide: "dcb0160",
  },
  { key: "dpia_signed", title: "The DPIA is signed", requiredForGoLive: true, guide: "dpia" },
  {
    key: "sub_processors_acknowledged",
    title: "Sub-processors are acknowledged",
    requiredForGoLive: false,
    guide: "sub-processors",
  },
  {
    key: "data_opt_out",
    title: "The national data opt-out is set up",
    requiredForGoLive: false,
    guide: "national-data-opt-out",
  },
  {
    key: "sample_data_removed",
    title: "Sample data is removed",
    requiredForGoLive: true,
    guide: "sample-data",
  },
] as const;

export type OnboardingItemKey = (typeof ONBOARDING_ITEMS)[number]["key"];

/** CQC location IDs look like "1-123456789" (data-standards.md). Checked without a regex. */
export function isCqcLocationId(value: string | null): boolean {
  if (value === null || value.length < 3 || value.length > 20 || !value.startsWith("1-")) {
    return false;
  }
  for (const ch of value.slice(2)) if (ch < "0" || ch > "9") return false;
  return true;
}

/** ODS codes: upper-case letters and digits, 3 to 10 characters (data-standards.md). */
export function isOdsCode(value: string | null): boolean {
  if (value === null || value.length < 3 || value.length > 10) return false;
  for (const ch of value) {
    if (!((ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9"))) return false;
  }
  return true;
}

export type RetentionDecisionKind = "accepted" | "lengthened" | "period_set" | "not_used";

/**
 * Rate-table settings with clinical meaning (device auto-lock, post-fall observations, shift
 * handover, repositioning, bowel and weight prompts, DoLS reminders): the clinical lead reviews
 * them before go-live, apart from the other defaults (HZ-027, HZ-018, HZ-009).
 */
export const CLINICAL_SETTING_PREFIXES: readonly string[] = [
  "mobile.auto_lock_seconds.",
  "falls.",
  "handover.",
  "repositioning.",
  "bowel.",
  "weight.",
  "dols.expiry_reminder_days.",
];

export function isClinicalSetting(key: string): boolean {
  return CLINICAL_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Escalation chains every organisation needs before go-live: deterioration from a validated tool
 * (HZ-014), overdue care tasks (HZ-008), statutory notifications due (HZ-013) and post-fall
 * observations (HZ-027).
 */
export const REQUIRED_ESCALATION_CHAINS: readonly string[] = [
  "deterioration",
  "overdue_task",
  "statutory_notification",
  "post_fall_observation",
];

export const PERSON_READINESS_GAPS = [
  "photo",
  "allergy_status",
  "resuscitation",
  "communication_needs",
  "iddsi_levels",
] as const;
export type PersonReadinessGap = (typeof PERSON_READINESS_GAPS)[number];

export interface PersonReadinessInput {
  readonly id: string;
  readonly status: PersonStatus;
  readonly sample: boolean;
  readonly hasPhoto: boolean;
  readonly allergyStatus: "unknown" | "no_known_allergies" | "has_allergies";
  /** A CPR decision in force, a positive "no decision in place" statement, or nothing recorded. */
  readonly resuscitation: "recorded" | "no_decision_in_place" | "not_recorded";
  readonly communicationNeedsStatus: "not_recorded" | "none_identified" | "recorded";
  readonly iddsiFoodLevel: string | null;
  readonly iddsiDrinkLevel: string | null;
}

/**
 * What a person receiving care still needs before go-live, from their record: a photo for
 * identification (HZ-001); an allergy status other than unknown (HZ-007); a resuscitation status,
 * either a decision in force or a recorded "no decision in place" (HZ-015); a communication-needs
 * status (HZ-023); and IDDSI food and drink levels (HZ-016).
 */
export function personReadinessGaps(person: PersonReadinessInput): PersonReadinessGap[] {
  const gaps: PersonReadinessGap[] = [];
  if (!person.hasPhoto) gaps.push("photo");
  if (person.allergyStatus === "unknown") gaps.push("allergy_status");
  if (person.resuscitation === "not_recorded") gaps.push("resuscitation");
  if (person.communicationNeedsStatus === "not_recorded") gaps.push("communication_needs");
  if (person.iddsiFoodLevel === null || person.iddsiDrinkLevel === null) gaps.push("iddsi_levels");
  return gaps;
}

export interface OnboardingState {
  readonly locations: readonly {
    readonly id: string;
    readonly regulator: string;
    readonly regulatorLocationId: string | null;
    readonly odsCode: string | null;
    readonly active: boolean;
    readonly registeredManagerAssigned: boolean;
  }[];
  readonly users: readonly {
    readonly id: string;
    readonly status: "invited" | "active" | "suspended" | "left";
    readonly owner: boolean;
    readonly readsCareRecords: boolean;
    readonly mfaEnrolled: boolean;
  }[];
  /** Rate-table keys that seed tenant settings, with when Harbour last changed the default. */
  readonly tenantDefaults: readonly { readonly key: string; readonly changedAt: Date }[];
  /** The organisation's decision on each: accepting the default or setting its own. */
  readonly rateDecisions: readonly { readonly key: string; readonly decidedAt: Date }[];
  readonly retentionClasses: readonly {
    readonly recordClass: string;
    readonly trigger: string;
    readonly changedAt: Date;
  }[];
  readonly retentionDecisions: readonly {
    readonly recordClass: string;
    readonly kind: RetentionDecisionKind;
    readonly decidedAt: Date;
  }[];
  /** `staff_file.after_leaving` or `staff_file.to_75th_birthday`, once chosen. */
  readonly staffFileOption: string | null;
  readonly dpia: { readonly state: DpiaState; readonly triggers: readonly DpiaReviewTrigger[] };
  readonly subProcessorsInUse: readonly string[];
  /** Acknowledgements, and when each sub-processor's entry last changed. */
  readonly subProcessorAcknowledgements: readonly {
    readonly key: string;
    readonly acknowledgedAt: Date;
  }[];
  readonly subProcessorChangedAt: Readonly<Record<string, Date>>;
  readonly dataOptOut: {
    /** Whether the organisation uses care data beyond direct care (for example NHS reporting). */
    readonly usesDataBeyondDirectCare: boolean | null;
    /** Current people whose opt-out status has not been checked. */
    readonly peopleNotChecked: number;
  };
  /** Null while Harbour does not record sample data yet: never read as "none". */
  readonly sampleDataPresent: boolean | null;
  /** Null while Harbour does not record device modes yet: never read as "no shared devices". */
  readonly devices:
    | readonly {
        readonly id: string;
        readonly mode: "personal" | "shared" | "kiosk";
        readonly active: boolean;
        readonly mdmEnrolled: boolean;
      }[]
    | null;
  readonly escalationChains: readonly {
    readonly key: string;
    readonly steps: readonly EscalationStep[];
  }[];
  /**
   * Validated tools switched on, with the tenant escalation policy document each links. From the
   * care API follow-ups the organisation's escalation policy links say whether every result of the
   * tool finds a policy (`escalationPolicyLinked`, from `validatedToolsWithLinks`); when that is
   * given it decides, otherwise the document does.
   */
  readonly validatedTools: readonly {
    readonly key: string;
    readonly enabled: boolean;
    readonly escalationPolicyDocumentId: string | null;
    readonly escalationPolicyLinked?: boolean;
  }[];
  readonly people: readonly PersonReadinessInput[];
  /** The DCB0160 assessment the tenant's CSO or clinical lead recorded, and the safety case it covers. */
  readonly dcb0160: {
    readonly recordedAt: Date | null;
    readonly safetyCaseVersion: string | null;
  };
  /** Harbour's safety case for the release the tenant runs. */
  readonly currentSafetyCaseVersion: string;
}

export interface OnboardingItemResult {
  readonly key: OnboardingItemKey;
  readonly title: string;
  readonly requiredForGoLive: boolean;
  readonly guide: string;
  readonly done: boolean;
  /** Plain English, worked out from the state. */
  readonly reason: string;
  /** Ids or keys still outstanding, for the screen to list. */
  readonly outstanding: readonly string[];
  /** For people readiness: each person still outstanding with what they lack. */
  readonly people?: readonly {
    readonly personId: string;
    readonly gaps: readonly PersonReadinessGap[];
  }[];
}

export interface OnboardingChecklist {
  readonly items: readonly OnboardingItemResult[];
  readonly done: number;
  readonly total: number;
  readonly readyForGoLive: boolean;
  readonly blockers: readonly OnboardingItemKey[];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type Outcome = {
  readonly done: boolean;
  readonly reason: string;
  readonly outstanding: readonly string[];
  readonly people?: OnboardingItemResult["people"];
};

function locationsItem(state: OnboardingState): Outcome {
  const active = state.locations.filter((l) => l.active);
  if (active.length === 0)
    return { done: false, reason: "Add your first location.", outstanding: [] };
  const missing = active
    .filter((l) => {
      const regulatorId =
        l.regulator === "cqc"
          ? isCqcLocationId(l.regulatorLocationId)
          : (l.regulatorLocationId ?? "").trim().length > 0;
      return !regulatorId || !isOdsCode(l.odsCode);
    })
    .map((l) => l.id);
  return missing.length === 0
    ? {
        done: true,
        reason: `All ${plural(active.length, "location has", "locations have")} their IDs.`,
        outstanding: [],
      }
    : {
        done: false,
        reason: `${plural(missing.length, "location needs", "locations need")} a valid regulator location ID or ODS code.`,
        outstanding: missing,
      };
}

function managersItem(state: OnboardingState): Outcome {
  const active = state.locations.filter((l) => l.active);
  if (active.length === 0)
    return { done: false, reason: "Add your first location.", outstanding: [] };
  const missing = active.filter((l) => !l.registeredManagerAssigned).map((l) => l.id);
  return missing.length === 0
    ? { done: true, reason: "Every location has a Registered Manager.", outstanding: [] }
    : {
        done: false,
        reason: `${plural(missing.length, "location has", "locations have")} no Registered Manager yet.`,
        outstanding: missing,
      };
}

function usersItem(state: OnboardingState): Outcome {
  const active = state.users.filter((u) => u.status === "active");
  const joined = active.filter((u) => !u.owner);
  const withoutMfa = active.filter((u) => u.readsCareRecords && !u.mfaEnrolled).map((u) => u.id);
  if (joined.length === 0) {
    return {
      done: false,
      reason: "No one other than the owner has joined yet.",
      outstanding: withoutMfa,
    };
  }
  if (withoutMfa.length > 0) {
    return {
      done: false,
      reason: `${plural(withoutMfa.length, "person who can read care records has", "people who can read care records have")} not set up a second sign-in step.`,
      outstanding: withoutMfa,
    };
  }
  return {
    done: true,
    reason: `${plural(joined.length, "member of staff has", "members of staff have")} joined, all with a second sign-in step where needed.`,
    outstanding: [],
  };
}

function pendingDefaults(state: OnboardingState, clinical: boolean): string[] {
  return state.tenantDefaults
    .filter((d) => isClinicalSetting(d.key) === clinical)
    .filter(
      (d) =>
        !state.rateDecisions.some(
          (r) => r.key === d.key && r.decidedAt.getTime() >= d.changedAt.getTime(),
        ),
    )
    .map((d) => d.key);
}

function ratesItem(state: OnboardingState): Outcome {
  const pending = pendingDefaults(state, false);
  return pending.length === 0
    ? {
        done: true,
        reason: "Every other setting Harbour chose for you has been reviewed.",
        outstanding: [],
      }
    : {
        done: false,
        reason: `${plural(pending.length, "setting needs", "settings need")} your review.`,
        outstanding: pending,
      };
}

function clinicalSettingsItem(state: OnboardingState): Outcome {
  const pending = pendingDefaults(state, true);
  return pending.length === 0
    ? {
        done: true,
        reason: "Your clinical lead has reviewed every clinical setting.",
        outstanding: [],
      }
    : {
        done: false,
        reason: `${plural(pending.length, "clinical setting needs", "clinical settings need")} your clinical lead's review (for example device auto-lock and post-fall observations).`,
        outstanding: pending,
      };
}

/** A fact Harbour does not record yet is not known, so the item cannot be done (fail closed). */
const NOT_YET_RECORDED = "Harbour does not record this yet, so it cannot be checked.";

function devicesItem(state: OnboardingState): Outcome {
  if (state.devices === null) return { done: false, reason: NOT_YET_RECORDED, outstanding: [] };
  const shared = state.devices.filter((d) => d.active && d.mode !== "personal");
  const missing = shared.filter((d) => !d.mdmEnrolled).map((d) => d.id);
  if (shared.length === 0) {
    return { done: true, reason: "No shared or kiosk devices are registered.", outstanding: [] };
  }
  return missing.length === 0
    ? { done: true, reason: "Every shared and kiosk device is enrolled.", outstanding: [] }
    : {
        done: false,
        reason: `${plural(missing.length, "shared device is", "shared devices are")} not enrolled in device management.`,
        outstanding: missing,
      };
}

function escalationChainsItem(state: OnboardingState): Outcome {
  const missing = REQUIRED_ESCALATION_CHAINS.filter((key) => {
    const chain = state.escalationChains.find((c) => c.key === key);
    return !chain || chain.steps.length === 0 || validateChain(chain.steps).length > 0;
  });
  return missing.length === 0
    ? { done: true, reason: "Every urgent alert has an escalation chain.", outstanding: [] }
    : {
        done: false,
        reason: `${plural(missing.length, "alert has", "alerts have")} no working escalation chain.`,
        outstanding: missing,
      };
}

function escalationPoliciesItem(state: OnboardingState): Outcome {
  const missing = state.validatedTools
    .filter(
      (t) => t.enabled && !(t.escalationPolicyLinked ?? t.escalationPolicyDocumentId !== null),
    )
    .map((t) => t.key);
  return missing.length === 0
    ? {
        done: true,
        reason: "Every validated tool in use links your escalation policy.",
        outstanding: [],
      }
    : {
        done: false,
        reason: `${plural(missing.length, "validated tool has", "validated tools have")} no escalation policy linked.`,
        outstanding: missing,
      };
}

function peopleItem(state: OnboardingState): Outcome {
  const people = state.people
    .filter((p) => !p.sample && LIVE_PERSON_STATUSES.includes(p.status))
    .map((p) => ({ personId: p.id, gaps: personReadinessGaps(p) }))
    .filter((p) => p.gaps.length > 0);
  return people.length === 0
    ? {
        done: true,
        reason: "Every person has a photo and their safety-critical facts recorded.",
        outstanding: [],
        people: [],
      }
    : {
        done: false,
        reason: `${plural(people.length, "person needs", "people need")} a photo, allergy status, resuscitation status, communication needs or IDDSI levels recorded.`,
        outstanding: people.map((p) => p.personId),
        people,
      };
}

function dcb0160Item(state: OnboardingState): Outcome {
  const { recordedAt, safetyCaseVersion } = state.dcb0160;
  if (recordedAt === null) {
    return {
      done: false,
      reason: "Your CSO or clinical lead has not recorded your DCB0160 assessment.",
      outstanding: [],
    };
  }
  return safetyCaseVersion === state.currentSafetyCaseVersion
    ? { done: true, reason: "Your DCB0160 assessment covers this release.", outstanding: [] }
    : {
        done: false,
        reason: `Your DCB0160 assessment covers an earlier safety case; review it for ${state.currentSafetyCaseVersion}.`,
        outstanding: [state.currentSafetyCaseVersion],
      };
}

const STAFF_FILE_PREFIX = "staff_file.";

function retentionItem(state: OnboardingState): Outcome {
  const pending: string[] = [];
  for (const c of state.retentionClasses) {
    if (c.recordClass.startsWith(STAFF_FILE_PREFIX)) continue;
    const allowed: readonly RetentionDecisionKind[] =
      c.trigger === "tenant_policy" ? ["period_set", "not_used"] : ["accepted", "lengthened"];
    // The latest decision for the class stands; an earlier one never counts once overtaken.
    const latest = state.retentionDecisions
      .filter((d) => d.recordClass === c.recordClass)
      .reduce<OnboardingState["retentionDecisions"][number] | null>(
        (last, d) => (last === null || d.decidedAt.getTime() > last.decidedAt.getTime() ? d : last),
        null,
      );
    const decided =
      latest !== null &&
      allowed.includes(latest.kind) &&
      latest.decidedAt.getTime() >= c.changedAt.getTime();
    if (!decided) pending.push(c.recordClass);
  }
  const staffOptions = state.retentionClasses.filter((c) =>
    c.recordClass.startsWith(STAFF_FILE_PREFIX),
  );
  if (
    staffOptions.length > 0 &&
    !staffOptions.some((c) => c.recordClass === state.staffFileOption)
  ) {
    pending.push("staff_file");
  }
  return pending.length === 0
    ? { done: true, reason: "Every retention period has been reviewed.", outstanding: [] }
    : {
        done: false,
        reason: `${plural(pending.length, "kind of record needs", "kinds of record need")} a retention decision.`,
        outstanding: pending,
      };
}

function dpiaItem(state: OnboardingState): Outcome {
  switch (state.dpia.state) {
    case "signed":
      return {
        done: true,
        reason: "The DPIA is signed and covers your current set-up.",
        outstanding: [],
      };
    case "review_due":
      return {
        done: false,
        reason: "The DPIA needs reviewing because your set-up has changed or a year has passed.",
        outstanding: state.dpia.triggers.map((t) => t.kind),
      };
    case "prepared":
      return {
        done: false,
        reason: "The DPIA is ready for your data protection lead to sign.",
        outstanding: [],
      };
    case "draft":
      return { done: false, reason: "The DPIA is being prepared.", outstanding: [] };
    case "not_started":
      return {
        done: false,
        reason: "Start the DPIA: Harbour has filled in what it can.",
        outstanding: [],
      };
  }
}

function subProcessorsItem(state: OnboardingState): Outcome {
  const pending = state.subProcessorsInUse.filter((key) => {
    const changed = state.subProcessorChangedAt[key];
    return !state.subProcessorAcknowledgements.some(
      (a) =>
        a.key === key && (changed === undefined || a.acknowledgedAt.getTime() >= changed.getTime()),
    );
  });
  return pending.length === 0
    ? {
        done: true,
        reason: "Every sub-processor your set-up uses is acknowledged.",
        outstanding: [],
      }
    : {
        done: false,
        reason: `${plural(pending.length, "sub-processor needs", "sub-processors need")} acknowledging.`,
        outstanding: pending,
      };
}

function optOutItem(state: OnboardingState): Outcome {
  const { usesDataBeyondDirectCare, peopleNotChecked } = state.dataOptOut;
  if (usesDataBeyondDirectCare === null) {
    return {
      done: false,
      reason: "Say whether you use care data beyond direct care, for example in NHS reporting.",
      outstanding: [],
    };
  }
  if (!usesDataBeyondDirectCare) {
    return {
      done: true,
      reason: "You use care data for direct care only, so the opt-out does not apply yet.",
      outstanding: [],
    };
  }
  return peopleNotChecked === 0
    ? { done: true, reason: "Every person's opt-out status has been checked.", outstanding: [] }
    : {
        done: false,
        reason: `${plural(peopleNotChecked, "person's", "people's")} opt-out status has not been checked.`,
        outstanding: [],
      };
}

function sampleItem(state: OnboardingState): Outcome {
  if (state.sampleDataPresent === null) {
    return { done: false, reason: NOT_YET_RECORDED, outstanding: [] };
  }
  return state.sampleDataPresent
    ? { done: false, reason: "Remove the sample data before you add real people.", outstanding: [] }
    : { done: true, reason: "There is no sample data.", outstanding: [] };
}

const RULES: Record<OnboardingItemKey, (state: OnboardingState) => Outcome> = {
  locations_identified: locationsItem,
  registered_managers: managersItem,
  first_users_with_mfa: usersItem,
  shared_devices_enrolled: devicesItem,
  escalation_chains_set: escalationChainsItem,
  escalation_policies_linked: escalationPoliciesItem,
  clinical_settings_reviewed: clinicalSettingsItem,
  people_ready: peopleItem,
  rates_reviewed: ratesItem,
  retention_reviewed: retentionItem,
  dcb0160_recorded: dcb0160Item,
  dpia_signed: dpiaItem,
  sub_processors_acknowledged: subProcessorsItem,
  data_opt_out: optOutItem,
  sample_data_removed: sampleItem,
};

/** The checklist, in order, from the organisation's state. */
export function onboardingChecklist(state: OnboardingState): OnboardingChecklist {
  const items = ONBOARDING_ITEMS.map(
    (item): OnboardingItemResult => ({ ...item, ...RULES[item.key](state) }),
  );
  const blockers = items.filter((i) => i.requiredForGoLive && !i.done).map((i) => i.key);
  return {
    items,
    done: items.filter((i) => i.done).length,
    total: items.length,
    readyForGoLive: blockers.length === 0,
    blockers,
  };
}

/**
 * Rate-table rows that seed tenant settings: those whose source says "tenant default" or "tenant
 * setting" (rates.md convention). Used until `rate_table` carries its own tenant-default column.
 */
export function tenantDefaultRateKeys(
  rows: readonly { readonly key: string; readonly source: string }[],
): string[] {
  const keys = rows
    .filter((r) => {
      const source = r.source.toLowerCase();
      return source.includes("tenant default") || source.includes("tenant setting");
    })
    .map((r) => r.key);
  return [...new Set(keys)].sort();
}

// ------------------------------------------------------------------------------------------------
// Onboarding decisions (rule 27): a person decides, and the decision is a record with who and when
// ------------------------------------------------------------------------------------------------

export type SettingDecisionKind = "accepted" | "set";

export type DecisionProblem =
  | "not_a_tenant_default"
  | "no_own_setting"
  | "not_a_retention_class"
  | "staff_file_is_an_option"
  | "kind_not_for_class"
  | "no_own_period"
  | "not_longer"
  | "safety_case_not_current";

export interface DecisionIssue {
  readonly problem: DecisionProblem;
  readonly message: string;
}

/**
 * A decision on a tenant-default setting: accepting Harbour's default, or saying the organisation
 * has set its own, which needs its own figure in the rate table first. Never a tick on its own.
 */
export function checkSettingDecision(input: {
  readonly kind: SettingDecisionKind;
  readonly isTenantDefault: boolean;
  readonly hasOwnSetting: boolean;
}): DecisionIssue | null {
  if (!input.isTenantDefault) {
    return {
      problem: "not_a_tenant_default",
      message: "This is not a setting Harbour chose for you.",
    };
  }
  if (input.kind === "set" && !input.hasOwnSetting) {
    return {
      problem: "no_own_setting",
      message: "Set your own figure first, then record the decision.",
    };
  }
  return null;
}

/** Months in a retention period, to compare periods given in years or months. */
const monthsOf = (p: { readonly period: number; readonly unit: string }) =>
  p.unit === "years" ? p.period * 12 : p.period;

/**
 * A decision on a retention class (rule 26): a class with a default is accepted, or lengthened to
 * the organisation's own longer period; a class the organisation's policy sets has its period set,
 * or is marked not used. Lengthening or setting needs the organisation's own period first, and a
 * lengthened period must be longer than the default. The staff file option is chosen on its own.
 */
export function checkRetentionDecision(input: {
  readonly recordClass: string;
  readonly kind: RetentionDecisionKind;
  /** The schedule's row for the class, or null when there is none. */
  readonly schedule: {
    readonly trigger: string;
    readonly period: number;
    readonly unit: string;
  } | null;
  /** The organisation's own period for the class, if it has one. */
  readonly own: { readonly period: number; readonly unit: string } | null;
}): DecisionIssue | null {
  const { schedule, own, kind } = input;
  if (schedule === null) {
    return { problem: "not_a_retention_class", message: "There is no such kind of record." };
  }
  if (input.recordClass.startsWith(STAFF_FILE_PREFIX)) {
    return {
      problem: "staff_file_is_an_option",
      message: "Choose how long staff files are kept with the staff file option.",
    };
  }
  const byPolicy = schedule.trigger === "tenant_policy";
  const allowed: readonly RetentionDecisionKind[] = byPolicy
    ? ["period_set", "not_used"]
    : ["accepted", "lengthened"];
  if (!allowed.includes(kind)) {
    return {
      problem: "kind_not_for_class",
      message: byPolicy
        ? "Your policy sets this period: set it, or mark this kind of record not used."
        : "Accept Harbour's period for this kind of record, or lengthen it.",
    };
  }
  if ((kind === "lengthened" || kind === "period_set") && own === null) {
    return {
      problem: "no_own_period",
      message: "Set your own period first, then record the decision.",
    };
  }
  if (kind === "lengthened" && own !== null && monthsOf(own) <= monthsOf(schedule)) {
    return {
      problem: "not_longer",
      message: "Your period must be longer than Harbour's; otherwise accept it.",
    };
  }
  return null;
}

/**
 * A DCB0160 assessment is recorded against Harbour's safety case for the release the organisation
 * runs, as the recorder read it: an assessment of an earlier one does not cover this release.
 */
export function checkDcb0160Recording(input: {
  readonly safetyCaseVersion: string;
  readonly currentSafetyCaseVersion: string;
}): DecisionIssue | null {
  return input.safetyCaseVersion.trim() === input.currentSafetyCaseVersion
    ? null
    : {
        problem: "safety_case_not_current",
        message: `Assess the deployment against the current safety case, ${input.currentSafetyCaseVersion}.`,
      };
}

export const STAFF_FILE_OPTIONS = [
  "staff_file.after_leaving",
  "staff_file.to_75th_birthday",
] as const;
export type StaffFileOption = (typeof STAFF_FILE_OPTIONS)[number];

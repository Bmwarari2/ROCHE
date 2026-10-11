import type { DpiaReviewTrigger, DpiaState } from "./dpia";

/**
 * Tenant onboarding checklist (master prompt section 9.1, "Help and onboarding";
 * platform-completions.md rules 26 to 28). Every item is worked out from the organisation's
 * configuration and records, never from a box someone ticks, so the list cannot say "done" while
 * the state says otherwise. Each item gives its reason from the same state and links an in-app
 * guide. Items marked required must be done before go-live.
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
    key: "rates_reviewed",
    title: "Settings Harbour chose for you are reviewed",
    requiredForGoLive: false,
    guide: "review-settings",
  },
  {
    key: "retention_reviewed",
    title: "How long records are kept is reviewed",
    requiredForGoLive: true,
    guide: "retention",
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
  readonly sampleDataPresent: boolean;
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

function ratesItem(state: OnboardingState): Outcome {
  const pending = state.tenantDefaults
    .filter(
      (d) =>
        !state.rateDecisions.some(
          (r) => r.key === d.key && r.decidedAt.getTime() >= d.changedAt.getTime(),
        ),
    )
    .map((d) => d.key);
  return pending.length === 0
    ? {
        done: true,
        reason: "Every setting Harbour chose for you has been reviewed.",
        outstanding: [],
      }
    : {
        done: false,
        reason: `${plural(pending.length, "setting needs", "settings need")} your review.`,
        outstanding: pending,
      };
}

const STAFF_FILE_PREFIX = "staff_file.";

function retentionItem(state: OnboardingState): Outcome {
  const pending: string[] = [];
  for (const c of state.retentionClasses) {
    if (c.recordClass.startsWith(STAFF_FILE_PREFIX)) continue;
    const allowed: readonly RetentionDecisionKind[] =
      c.trigger === "tenant_policy" ? ["period_set", "not_used"] : ["accepted", "lengthened"];
    const decided = state.retentionDecisions.some(
      (d) =>
        d.recordClass === c.recordClass &&
        allowed.includes(d.kind) &&
        d.decidedAt.getTime() >= c.changedAt.getTime(),
    );
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
  return state.sampleDataPresent
    ? { done: false, reason: "Remove the sample data before you add real people.", outstanding: [] }
    : { done: true, reason: "There is no sample data.", outstanding: [] };
}

const RULES: Record<OnboardingItemKey, (state: OnboardingState) => Outcome> = {
  locations_identified: locationsItem,
  registered_managers: managersItem,
  first_users_with_mfa: usersItem,
  rates_reviewed: ratesItem,
  retention_reviewed: retentionItem,
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

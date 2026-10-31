/**
 * Feature flags and module licensing (section 9.1). Evaluated through OpenFeature
 * (`apps/api/src/flags`): the organisation's `feature_flag` rows (location row, then tenant row),
 * then Flagsmith where it is configured and may set the flag (`remoteMaySet`), then the defaults
 * here. The AI module is always off by default, and only the organisation's own row turns it on.
 */

export interface FlagDefinition {
  readonly description: string;
  readonly defaultEnabled: boolean;
  /** Licensed modules appear on the tenant's Harbour bill when enabled. */
  readonly licensed: boolean;
  /** An AI flag: off by default, and on only where the organisation's own row says so (section 5). */
  readonly ai?: boolean;
  /**
   * Flagsmith may set this flag where the organisation has no row of its own. Off unless marked:
   * only modules with no clinical or data-protection effect are marked, never an AI flag.
   */
  readonly remote?: boolean;
}

export const FLAGS = {
  "module.residential": {
    description: "Residential and nursing care records",
    defaultEnabled: true,
    licensed: true,
  },
  "module.domiciliary": {
    description: "Home care scheduling and electronic call monitoring",
    defaultEnabled: false,
    licensed: true,
  },
  "module.supported_living": {
    description: "Supported living tenancy and support hours",
    defaultEnabled: false,
    licensed: true,
  },
  "module.finance": {
    description: "Funding, billing and residents' money",
    defaultEnabled: false,
    licensed: true,
  },
  "module.emar": {
    description: "Electronic MAR and controlled drugs",
    defaultEnabled: false,
    licensed: true,
  },
  "module.workforce": {
    description: "Recruitment, training, rostering and pay rules",
    defaultEnabled: false,
    licensed: true,
  },
  "module.family_portal": {
    description: "Family and person portals",
    defaultEnabled: false,
    licensed: true,
  },
  "module.ai": {
    description: "AI management copilot (advisory only; needs the DPIA AI addendum)",
    defaultEnabled: false,
    licensed: true,
    ai: true,
  },
  "module.public_site": {
    description: "Public website with vacancies and fees",
    defaultEnabled: false,
    licensed: true,
    remote: true,
  },
  "locale.welsh": {
    description: "Welsh language interface and Active Offer",
    defaultEnabled: false,
    licensed: false,
  },
  "dols.post_2026_review_workflow": {
    description: "Review existing DoLS authorisations after the June 2026 Supreme Court judgment",
    defaultEnabled: true,
    licensed: false,
  },
  // Lone-worker location (SCHED-012, H-527): evidence only, captured with a check-in, help or
  // duress event and never as a track; off until the employee-monitoring DPIA allows it.
  "scheduling.lone_worker.location": {
    description: "Attach the device's location to lone-worker check-ins and alarms (evidence only)",
    defaultEnabled: false,
    licensed: false,
  },
  // Validated tools whose terms of use in software are not yet confirmed (human action H-25,
  // care.md section 10): off for real tenants, switched on for the demo tenant by the seed.
  "care.tool.waterlow": {
    description: "Waterlow pressure ulcer risk score (until its licence and source are confirmed)",
    defaultEnabled: false,
    licensed: false,
  },
  "care.tool.braden": {
    description: "Braden Scale for pressure sore risk (until its licence is confirmed)",
    defaultEnabled: false,
    licensed: false,
  },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;

export interface FlagRow {
  readonly flagKey: string;
  readonly locationId: string | null;
  readonly enabled: boolean;
}

/** Where a flag's value came from, for the evaluation's reason. */
export type FlagSource = "location" | "tenant" | "remote" | "catalogue";

export function isFlagKey(value: string): value is FlagKey {
  return Object.hasOwn(FLAGS, value);
}

export function isAiFlag(key: FlagKey): boolean {
  const definition: FlagDefinition = FLAGS[key];
  return definition.ai === true;
}

/**
 * Whether Flagsmith may set the flag's value where the organisation has no row of its own: only a
 * flag marked `remote` (an explicit allowlist, #39 review M1), and never an AI flag. Clinical
 * modules and tools, data-protection modules (the family portal, residents' money), review
 * workflows and the language change only by the organisation's own audited row, so the API and
 * every screen read them the same way.
 */
export function remoteMaySet(key: FlagKey): boolean {
  const definition: FlagDefinition = FLAGS[key];
  return definition.remote === true && !isAiFlag(key);
}

/**
 * The location row, then the tenant row, then the remote value (only where `remoteMaySet`, and
 * only when the remote provider answered), then the catalogue default. AI flags are never on by
 * default.
 */
export function resolveFlag(
  key: FlagKey,
  rows: readonly FlagRow[],
  locationId: string | null,
  remote?: boolean,
): { readonly enabled: boolean; readonly source: FlagSource } {
  if (locationId !== null) {
    const atLocation = rows.find((r) => r.flagKey === key && r.locationId === locationId);
    if (atLocation) return { enabled: atLocation.enabled, source: "location" };
  }
  const tenantWide = rows.find((r) => r.flagKey === key && r.locationId === null);
  if (tenantWide) return { enabled: tenantWide.enabled, source: "tenant" };
  if (remote !== undefined && remoteMaySet(key)) return { enabled: remote, source: "remote" };
  return { enabled: FLAGS[key].defaultEnabled && !isAiFlag(key), source: "catalogue" };
}

/** Location rows override tenant rows, which override the catalogue default. */
export function evaluateFlag(
  key: FlagKey,
  rows: readonly FlagRow[],
  locationId: string | null,
): boolean {
  return resolveFlag(key, rows, locationId).enabled;
}

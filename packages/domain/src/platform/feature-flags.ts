/**
 * Feature flags and module licensing (section 9.1). Evaluated through OpenFeature; the default
 * provider reads the `feature_flag` table (tenant row, then location row), with Flagsmith as an
 * optional provider. Defaults here apply when no row exists. The AI module is always off by default.
 */

export interface FlagDefinition {
  readonly description: string;
  readonly defaultEnabled: boolean;
  /** Licensed modules appear on the tenant's Harbour bill when enabled. */
  readonly licensed: boolean;
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
  },
  "module.public_site": {
    description: "Public website with vacancies and fees",
    defaultEnabled: false,
    licensed: true,
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
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;

export interface FlagRow {
  readonly flagKey: string;
  readonly locationId: string | null;
  readonly enabled: boolean;
}

/** Location rows override tenant rows, which override the catalogue default. */
export function evaluateFlag(
  key: FlagKey,
  rows: readonly FlagRow[],
  locationId: string | null,
): boolean {
  if (locationId !== null) {
    const atLocation = rows.find((r) => r.flagKey === key && r.locationId === locationId);
    if (atLocation) return atLocation.enabled;
  }
  const tenantWide = rows.find((r) => r.flagKey === key && r.locationId === null);
  if (tenantWide) return tenantWide.enabled;
  return FLAGS[key].defaultEnabled;
}

import type { FlagKey } from "./feature-flags";

/**
 * Records of processing (UK GDPR Article 30; docs/compliance/records-of-processing.md Part B;
 * platform-completions.md rule 19). Each tenant is the controller; Harbour prefills its register
 * from the purposes below and the tenant's configuration, and the DPIA prefill reads the same
 * list. Consent is never the basis for care records: it covers only the optional purposes (family
 * portal photos, marketing, AI on free text), each of which needs its own switch.
 */

export type ControllerSector = "independent" | "public";

/** What makes a purpose apply to a tenant. */
export type PurposeTrigger =
  | { readonly kind: "always" }
  | { readonly kind: "feature"; readonly flag: FlagKey }
  | {
      readonly kind: "setting";
      readonly setting: OptionalProcessingSetting;
      readonly flag?: FlagKey;
    };

/** Optional processing the tenant switches on in its data protection settings. */
export type OptionalProcessingSetting = "marketing" | "ai_free_text";

export interface ProcessingPurpose {
  readonly title: string;
  readonly dataSubjects: string;
  readonly lawfulBasis: Readonly<Record<ControllerSector, string>>;
  readonly specialCategory: string | null;
  /** Consent-based optional processing; never true for care records. */
  readonly consent: boolean;
  readonly retention: string;
  readonly trigger: PurposeTrigger;
  /** Data categories (DATA_CATEGORIES keys) the purpose processes. */
  readonly dataCategories: readonly DataCategory[];
}

/**
 * Personal data categories, as the records of processing groups them. A category new to a
 * tenant (because a feature or a Harbour release brings it) triggers a DPIA re-review.
 */
export const DATA_CATEGORIES = {
  person_demographics: "People receiving care: MODS demographics, NHS number, photo",
  health_and_care: "Care plans, notes, charts, assessments, allergies, communication needs",
  contacts: "Family members, representatives and legal authorities",
  staff_accounts: "Staff accounts, roles, authenticators, devices",
  audit: "Audit trail, break-glass records, security logs",
  safeguarding: "Safeguarding concerns, alleged perpetrators, witnesses",
  regulatory_returns: "Statutory notifications and returns",
  organisation_officers: "Named officers of the organisation",
  medicines: "Medicines, administrations and controlled drugs",
  staff_employment: "Recruitment, DBS (criminal offence data), training, supervision, pay",
  residents_money: "Residents' money, fees and funding",
  visit_location: "Location and times from electronic call monitoring at people's homes",
  family_portal_content: "Photos and updates shared with families",
  marketing_contacts: "Enquirers and contacts who agreed to marketing",
  ai_interaction_log: "Pseudonymised prompts and outputs of the AI module",
  speak_up: "Speak-up concerns, who raised them when named or confidential, casework and replies",
} as const;
export type DataCategory = keyof typeof DATA_CATEGORIES;

/** Categories a module brings when it is switched on. */
export const FEATURE_DATA_CATEGORIES: Partial<Readonly<Record<FlagKey, readonly DataCategory[]>>> =
  {
    "module.emar": ["medicines"],
    "module.workforce": ["staff_employment"],
    "module.finance": ["residents_money"],
    "module.domiciliary": ["visit_location"],
    "module.family_portal": ["family_portal_content"],
    "module.ai": ["ai_interaction_log"],
  };

const INDEPENDENT_CARE =
  "Art 6(1)(b) contract, or 6(1)(f) legitimate interests where the contract is with a funder";

export const PROCESSING_PURPOSES = {
  B1: {
    title: "Delivering and recording health and social care",
    dataSubjects: "People receiving care",
    lawfulBasis: {
      independent: INDEPENDENT_CARE,
      public: "Art 6(1)(c) legal obligation or 6(1)(e) public task",
    },
    specialCategory:
      "Art 9(2)(h) with DPA 2018 s.10(2) and Sch 1 para 2 (health or social care purposes), under a duty of confidentiality (Art 9(3), DPA 2018 s.11)",
    consent: false,
    retention: "care_record: 8 years after care ends",
    trigger: { kind: "always" },
    dataCategories: ["person_demographics", "health_and_care"],
  },
  B2: {
    title: "Recording and contacting family members and representatives in connection with care",
    dataSubjects: "Family members, representatives, legal authorities",
    lawfulBasis: {
      independent: "Art 6(1)(f) legitimate interests",
      public: "Art 6(1)(e) public task",
    },
    specialCategory: null,
    consent: false,
    retention: "With the person's record",
    trigger: { kind: "always" },
    dataCategories: ["contacts"],
  },
  B3: {
    title: "Employment and workforce management",
    dataSubjects: "Staff and agency workers",
    lawfulBasis: {
      independent: "Art 6(1)(b) contract of employment; 6(1)(c) where a law requires the record",
      public: "Art 6(1)(b) contract of employment; 6(1)(c) where a law requires the record",
    },
    specialCategory:
      "Art 9(2)(b) with DPA 2018 Sch 1 para 1 (employment), with an appropriate policy document; criminal offence data under Art 10 with Sch 1 para 1",
    consent: false,
    retention:
      "Staff files: 6 years after leaving or to the 75th birthday, as the organisation selects",
    trigger: { kind: "always" },
    dataCategories: ["staff_accounts"],
  },
  B4: {
    title: "Safeguarding adults at risk",
    dataSubjects: "People receiving care, alleged perpetrators, witnesses, staff",
    lawfulBasis: {
      independent:
        "Art 6(1)(ea) recognised legitimate interest (safeguarding a vulnerable individual)",
      public: "Art 6(1)(c) or 6(1)(e)",
    },
    specialCategory:
      "Art 9(2)(g) with DPA 2018 Sch 1 para 18 (safeguarding of individuals at risk), with an appropriate policy document",
    consent: false,
    retention: "Per the retention schedule (serious_incident where notified)",
    trigger: { kind: "always" },
    dataCategories: ["safeguarding"],
  },
  B5: {
    title: "Security, audit and accountability",
    dataSubjects: "Staff (actors); people and contacts by opaque id",
    lawfulBasis: {
      independent:
        "Art 6(1)(c) legal obligation (UK GDPR Arts 5(2) and 32; Regulation 17) or 6(1)(f)",
      public: "Art 6(1)(c) or 6(1)(e)",
    },
    specialCategory: "Where an audit justification contains health data, as B1",
    consent: false,
    retention: "Security logs at least 6 months; audit of a care record as long as the record",
    trigger: { kind: "always" },
    dataCategories: ["audit"],
  },
  B6: {
    title: "Running the service: organisation and location administration",
    dataSubjects: "Named officers (Nominated Individual, Registered Manager)",
    lawfulBasis: { independent: "Art 6(1)(b) or 6(1)(f)", public: "Art 6(1)(e)" },
    specialCategory: null,
    consent: false,
    retention: "While the organisation is a customer, then per contract",
    trigger: { kind: "always" },
    dataCategories: ["organisation_officers"],
  },
  B7: {
    title: "Statutory notifications and regulatory returns",
    dataSubjects: "People receiving care, staff",
    lawfulBasis: {
      independent: "Art 6(1)(c) legal obligation",
      public: "Art 6(1)(c) legal obligation",
    },
    specialCategory:
      "Art 9(2)(h) with Sch 1 para 2, or Art 9(2)(i) with Sch 1 para 3 (public health) as applicable",
    consent: false,
    retention: "Per the retention schedule",
    trigger: { kind: "always" },
    dataCategories: ["regulatory_returns"],
  },
  B8: {
    title: "Optional: photos and updates shared in the family portal",
    dataSubjects: "People receiving care, family members",
    lawfulBasis: { independent: "Art 6(1)(a) consent", public: "Art 6(1)(a) consent" },
    specialCategory: "Art 9(2)(a) explicit consent where the photo or update reveals health",
    consent: true,
    retention: "Until consent is withdrawn or the record's retention ends",
    trigger: { kind: "feature", flag: "module.family_portal" },
    dataCategories: ["family_portal_content"],
  },
  B9: {
    title: "Optional: marketing to families and enquirers",
    dataSubjects: "Contacts, enquirers",
    lawfulBasis: {
      independent: "Art 6(1)(a) consent (and PECR)",
      public: "Art 6(1)(a) consent (and PECR)",
    },
    specialCategory: null,
    consent: true,
    retention: "Until consent is withdrawn",
    trigger: { kind: "setting", setting: "marketing" },
    dataCategories: ["marketing_contacts"],
  },
  B10: {
    title: "Optional: AI processing of free-text notes",
    dataSubjects: "People receiving care (pseudonymised), staff",
    lawfulBasis: {
      independent:
        "Art 6(1)(a) consent for free text; other AI features use the basis of the underlying purpose",
      public:
        "Art 6(1)(a) consent for free text; other AI features use the basis of the underlying purpose",
    },
    specialCategory: "Art 9(2)(a) explicit consent for free text",
    consent: true,
    retention: "Prompt and response audit 12 months (pseudonymised)",
    trigger: { kind: "setting", setting: "ai_free_text", flag: "module.ai" },
    dataCategories: ["ai_interaction_log"],
  },
  B15: {
    title:
      "Recruitment: job applicants, applications, shortlisting, interviews, conditional offers, the talent pool and equality monitoring",
    dataSubjects: "Job applicants (who may never be employed); interview panel members",
    lawfulBasis: {
      independent:
        "Art 6(1)(b) steps at the applicant's request before a contract, and 6(1)(f) legitimate interests in recruiting",
      public: "Art 6(1)(b) and 6(1)(e)",
    },
    specialCategory:
      "Equality monitoring only: Art 9(2)(g) with DPA 2018 Sch 1 para 8 (equality of opportunity or treatment), voluntary, kept apart and reported only as suppressed counts",
    // Recruitment is not consent based. Keeping someone in the talent pool longer is only with
    // their agreement, withdrawable at once (records-of-processing.md B15).
    consent: false,
    retention:
      "applicant.unsuccessful: 6 months after the last application closes; applicant.talent_pool: 12 months from the applicant's agreement, which they may withdraw",
    trigger: { kind: "feature", flag: "module.workforce" },
    dataCategories: ["staff_employment"],
  },
  B16: {
    title: "Whistleblowing and speaking up",
    dataSubjects:
      "Staff and agency workers who raise concerns, people a concern is about, people receiving care it mentions",
    lawfulBasis: {
      independent: "Art 6(1)(f) legitimate interests (PIDA protection, safe care)",
      public: "Art 6(1)(e) public task",
    },
    specialCategory:
      "Art 9(2)(b) with Sch 1 para 1 (employment), or Art 9(2)(h) with Sch 1 para 2 where a concern reveals health; Art 10 with Sch 1 para 10 where it alleges a crime",
    consent: false,
    retention: "As complaints until the controller sets a whistleblowing class (H-721)",
    trigger: { kind: "always" },
    dataCategories: ["speak_up"],
  },
} as const satisfies Record<string, ProcessingPurpose>;

export type ProcessingPurposeId = keyof typeof PROCESSING_PURPOSES;

export interface ProcessingConfig {
  readonly sector: ControllerSector;
  /** Feature flags switched on for the tenant (or planned, when preparing the DPIA first). */
  readonly features: readonly FlagKey[];
  readonly optional: Readonly<Record<OptionalProcessingSetting, boolean>>;
}

function applies(trigger: PurposeTrigger, config: ProcessingConfig): boolean {
  switch (trigger.kind) {
    case "always":
      return true;
    case "feature":
      return config.features.includes(trigger.flag);
    case "setting":
      return (
        config.optional[trigger.setting] &&
        (trigger.flag === undefined || config.features.includes(trigger.flag))
      );
  }
}

export interface RegisterRow {
  readonly id: ProcessingPurposeId;
  readonly title: string;
  readonly dataSubjects: string;
  readonly lawfulBasis: string;
  readonly specialCategory: string | null;
  readonly consent: boolean;
  readonly retention: string;
  readonly dataCategories: readonly DataCategory[];
}

/** The tenant's Part B register: the purposes that apply, with the basis for its sector. */
export function recordsOfProcessingRegister(config: ProcessingConfig): RegisterRow[] {
  return (Object.keys(PROCESSING_PURPOSES) as ProcessingPurposeId[])
    .filter((id) => applies(PROCESSING_PURPOSES[id].trigger, config))
    .map((id) => {
      const purpose: ProcessingPurpose = PROCESSING_PURPOSES[id];
      return {
        id,
        title: purpose.title,
        dataSubjects: purpose.dataSubjects,
        lawfulBasis: purpose.lawfulBasis[config.sector],
        specialCategory: purpose.specialCategory,
        consent: purpose.consent,
        retention: purpose.retention,
        dataCategories: purpose.dataCategories,
      };
    });
}

/** Every data category the tenant processes: its purposes' categories and its modules'. */
export function tenantDataCategories(config: ProcessingConfig): DataCategory[] {
  const categories = new Set<DataCategory>();
  for (const row of recordsOfProcessingRegister(config)) {
    for (const c of row.dataCategories) categories.add(c);
  }
  for (const flag of config.features) {
    for (const c of FEATURE_DATA_CATEGORIES[flag] ?? []) categories.add(c);
  }
  return [...categories].sort();
}

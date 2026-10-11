import { type AboutMeDocument, type AboutMeSummary, summariseAboutMe } from "./about-me";
import { hasReason } from "./dates";
import { LIVE_PERSON_STATUSES, type PersonStatus } from "./lifecycle";
import {
  type PropertyItemRecord,
  propertyAwayWithPerson,
  propertyToSendWithPerson,
} from "./property";

/**
 * Hospital transfer pack (master prompt section 9.2, the NHS England hospital transfer pathway or
 * "red bag"; people.md section 4 rule 10; hazards HZ-001, HZ-007, HZ-015, HZ-016 and HZ-023).
 * A pure function assembles the pack from record data the caller supplies. It never interprets
 * anything (medical-device boundary): it copies what is recorded and says plainly what is not.
 *
 * - It refuses to assemble when the identity is incomplete, when any section belongs to a
 *   different person (HZ-001), or when the person is not receiving care.
 * - Otherwise it always produces a pack, because a transfer must never wait for paperwork, but it
 *   flags every missing safety-critical section on the first page ("not recorded", never blank),
 *   and recording the hand-over of an incomplete pack needs a named person's acknowledgement.
 */

export interface TransferPackSectionDefinition {
  readonly key: string;
  readonly title: string;
  /** Safety-critical sections block a clean hand-over when missing. */
  readonly critical: boolean;
  readonly hazardIds: readonly string[];
}

export const TRANSFER_PACK_SECTIONS = [
  { key: "photo", title: "Photo", critical: true, hazardIds: ["HZ-001", "HZ-023"] },
  {
    key: "allergies",
    title: "Allergies and adverse reactions",
    critical: true,
    hazardIds: ["HZ-007", "HZ-023"],
  },
  { key: "medicines", title: "Current medicines", critical: true, hazardIds: ["HZ-023"] },
  { key: "communication", title: "Communication needs", critical: true, hazardIds: ["HZ-023"] },
  {
    key: "resuscitation",
    title: "Resuscitation status (ReSPECT, DNACPR)",
    critical: true,
    hazardIds: ["HZ-015", "HZ-023"],
  },
  { key: "about_me", title: "About Me", critical: true, hazardIds: ["HZ-023"] },
  {
    key: "reason_for_transfer",
    title: "Reason for transfer and what has changed",
    critical: false,
    hazardIds: ["HZ-023"],
  },
  { key: "baseline", title: "What is usual for this person", critical: false, hazardIds: [] },
  {
    key: "eating_and_drinking",
    title: "Eating and drinking (IDDSI levels)",
    critical: false,
    hazardIds: ["HZ-016"],
  },
  {
    key: "capacity_and_legal",
    title: "Mental capacity, DoLS and legal representatives",
    critical: false,
    hazardIds: [],
  },
  { key: "contacts", title: "Next of kin and representatives", critical: false, hazardIds: [] },
  { key: "infection", title: "Infection status", critical: false, hazardIds: [] },
  { key: "items_sent", title: "Belongings sent with the person", critical: false, hazardIds: [] },
  { key: "home_contact", title: "How to contact the home", critical: false, hazardIds: [] },
] as const satisfies readonly TransferPackSectionDefinition[];

export type TransferPackSectionKey = (typeof TRANSFER_PACK_SECTIONS)[number]["key"];

/** Record data for one section, with the person it belongs to and when it was last updated. */
export interface SectionSource<T> {
  readonly personId: string;
  readonly asOf: Date | null;
  readonly data: T;
}

export interface TransferIdentity {
  readonly personId: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName: string | null;
  /** yyyy-mm-dd */
  readonly dateOfBirth: string | null;
  readonly nhsNumber: string | null;
  readonly gpPracticeOdsCode: string | null;
}

export interface TransferAllergy {
  readonly substance: string;
  readonly reaction: string | null;
  readonly severity: "mild" | "moderate" | "severe" | "unknown";
}

/** HZ-007: "unknown" is never shown as "no allergies". */
export type AllergyStatement =
  | { readonly status: "unknown" }
  | {
      readonly status: "no_known_allergies";
      readonly recordedBy: string;
      readonly recordedAt: Date;
    }
  | { readonly status: "has_allergies"; readonly allergies: readonly TransferAllergy[] };

export interface TransferMedicine {
  readonly name: string;
  readonly dose: string;
  readonly route: string;
  readonly frequency: string;
  readonly lastGivenAt: Date | null;
  /** Time-critical medicines (for example for Parkinson's disease) are listed first. */
  readonly timeCritical: boolean;
}

export type MedicinesStatement =
  | { readonly status: "not_recorded" }
  | { readonly status: "none"; readonly confirmedBy: string; readonly confirmedAt: Date }
  | {
      readonly status: "recorded";
      readonly source: "emar" | "medicines_list" | "pharmacy_mar";
      readonly items: readonly TransferMedicine[];
    };

export interface TransferCommunicationNeed {
  readonly code: string;
  readonly display: string;
  readonly preferredFormat: string;
}

export type CommunicationStatement =
  | { readonly status: "not_recorded" }
  | { readonly status: "none_identified"; readonly confirmedBy: string; readonly confirmedAt: Date }
  | { readonly status: "recorded"; readonly needs: readonly TransferCommunicationNeed[] };

export interface AdvanceCareSummary {
  readonly kind: "respect" | "dnacpr" | "adrt" | "advance_care_plan";
  /** The recorded recommendation in the clinician's words. */
  readonly summary: string;
  readonly clinician: string;
  readonly completedOn: string;
  readonly reviewOn: string | null;
  readonly documentId: string | null;
  /** Withdrawn or superseded records are never printed (HZ-015). */
  readonly active: boolean;
}

/** HZ-015: a missing decision reads "not recorded", never blank. */
export type ResuscitationStatement =
  | { readonly status: "not_recorded" }
  | {
      readonly status: "no_decision_in_place";
      readonly confirmedBy: string;
      readonly confirmedAt: Date;
    }
  | { readonly status: "recorded"; readonly records: readonly AdvanceCareSummary[] };

export interface TransferBaseline {
  readonly description: string;
  readonly observations: readonly {
    readonly label: string;
    readonly value: string;
    readonly at: Date;
  }[];
}

export interface TransferEatingAndDrinking {
  readonly foodLevel: number | null;
  readonly drinkLevel: number | null;
  readonly notes: string | null;
}

export interface TransferCapacityAndLegal {
  readonly summary: string;
  readonly dolsInPlace: boolean;
}

export interface TransferContact {
  readonly personId: string;
  readonly name: string;
  readonly relationship: string | null;
  readonly role: string;
  readonly phone: string | null;
}

export interface TransferPropertyItem extends PropertyItemRecord {
  readonly description: string;
}

export interface HospitalTransferInput {
  readonly personStatus: PersonStatus;
  readonly identity: TransferIdentity;
  readonly generatedAt: Date;
  readonly generatedBy: string;
  readonly photo: SectionSource<{ readonly documentId: string; readonly takenOn: string }> | null;
  readonly allergies: SectionSource<AllergyStatement>;
  readonly medicines: SectionSource<MedicinesStatement>;
  readonly communication: SectionSource<CommunicationStatement>;
  readonly resuscitation: SectionSource<ResuscitationStatement>;
  readonly aboutMe: SectionSource<AboutMeDocument> | null;
  readonly reasonForTransfer: string | null;
  readonly baseline: SectionSource<TransferBaseline> | null;
  readonly eatingAndDrinking: SectionSource<TransferEatingAndDrinking> | null;
  readonly capacityAndLegal: SectionSource<TransferCapacityAndLegal> | null;
  readonly contacts: readonly TransferContact[];
  readonly infection: SectionSource<{ readonly summary: string }> | null;
  /** The person's property inventory. */
  readonly property: readonly TransferPropertyItem[];
  /** Items going with the person (glasses, hearing aids, dentures, walking aid). */
  readonly sendItemIds: readonly string[];
  readonly homeContact: { readonly locationName: string; readonly phone: string } | null;
}

export interface TransferPackSectionStatus {
  readonly key: TransferPackSectionKey;
  readonly title: string;
  readonly critical: boolean;
  readonly hazardIds: readonly string[];
  readonly status: "included" | "not_recorded";
  readonly asOf: Date | null;
}

export interface HospitalTransferPack {
  readonly personId: string;
  readonly generatedAt: Date;
  readonly generatedBy: string;
  readonly identity: TransferIdentity;
  readonly sections: readonly TransferPackSectionStatus[];
  readonly content: {
    readonly photo: { readonly documentId: string; readonly takenOn: string } | null;
    readonly allergies: AllergyStatement;
    readonly medicines: MedicinesStatement;
    readonly communication: CommunicationStatement;
    readonly resuscitation: ResuscitationStatement;
    readonly aboutMe: {
      readonly document: AboutMeDocument;
      readonly summary: AboutMeSummary;
    } | null;
    readonly reasonForTransfer: string | null;
    readonly baseline: TransferBaseline | null;
    readonly eatingAndDrinking: TransferEatingAndDrinking | null;
    readonly capacityAndLegal: TransferCapacityAndLegal | null;
    readonly contacts: readonly TransferContact[];
    readonly infection: { readonly summary: string } | null;
    readonly itemsSent: readonly TransferPropertyItem[];
    readonly homeContact: { readonly locationName: string; readonly phone: string } | null;
  };
  /** Safety-critical sections not recorded, in pack order; shown on the first page. */
  readonly missingCritical: readonly TransferPackSectionKey[];
  readonly missingExpected: readonly TransferPackSectionKey[];
  /** Items of the kinds that travel with the person, held at the home and not being sent. */
  readonly itemsLeftBehind: readonly TransferPropertyItem[];
  readonly complete: boolean;
}

export type TransferPackRefusal = "not_receiving_care" | "identity_incomplete" | "wrong_person";

export type TransferPackResult =
  | { readonly ok: true; readonly pack: HospitalTransferPack }
  | {
      readonly ok: false;
      readonly problem: TransferPackRefusal;
      readonly message: string;
      /** For `wrong_person`: the sections whose data belongs to someone else. */
      readonly sections: readonly TransferPackSectionKey[];
    };

const REFUSAL_MESSAGES: Record<TransferPackRefusal, string> = {
  not_receiving_care: "A transfer pack is only made for someone receiving care from the home.",
  identity_incomplete: "The person's name and date of birth are needed to make a transfer pack.",
  wrong_person:
    "Some of the information belongs to a different person. The pack was not made. Check the record before trying again.",
};

const SEVERITY_ORDER: Record<TransferAllergy["severity"], number> = {
  severe: 0,
  moderate: 1,
  mild: 2,
  unknown: 3,
};

function normaliseAllergies(statement: AllergyStatement): AllergyStatement {
  if (statement.status !== "has_allergies") return statement;
  if (statement.allergies.length === 0) return { status: "unknown" };
  return {
    status: "has_allergies",
    allergies: [...statement.allergies].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    ),
  };
}

function normaliseMedicines(statement: MedicinesStatement): MedicinesStatement {
  if (statement.status !== "recorded") return statement;
  if (statement.items.length === 0) return { status: "not_recorded" };
  return {
    ...statement,
    items: [...statement.items].sort((a, b) => Number(b.timeCritical) - Number(a.timeCritical)),
  };
}

function normaliseCommunication(statement: CommunicationStatement): CommunicationStatement {
  if (statement.status === "recorded" && statement.needs.length === 0)
    return { status: "not_recorded" };
  return statement;
}

function normaliseResuscitation(statement: ResuscitationStatement): ResuscitationStatement {
  if (statement.status !== "recorded") return statement;
  const active = statement.records.filter((r) => r.active);
  return active.length === 0 ? { status: "not_recorded" } : { status: "recorded", records: active };
}

/** Assembles the hospital transfer pack from supplied record data. */
export function assembleHospitalTransferPack(input: HospitalTransferInput): TransferPackResult {
  const refuse = (
    problem: TransferPackRefusal,
    sections: TransferPackSectionKey[] = [],
  ): TransferPackResult => ({
    ok: false,
    problem,
    message: REFUSAL_MESSAGES[problem],
    sections,
  });
  if (!LIVE_PERSON_STATUSES.includes(input.personStatus)) return refuse("not_receiving_care");
  const { identity } = input;
  if (
    !hasReason(identity.givenName, 1) ||
    !hasReason(identity.familyName, 1) ||
    !identity.dateOfBirth
  ) {
    return refuse("identity_incomplete");
  }

  const sourced: [TransferPackSectionKey, { readonly personId: string } | null][] = [
    ["photo", input.photo],
    ["allergies", input.allergies],
    ["medicines", input.medicines],
    ["communication", input.communication],
    ["resuscitation", input.resuscitation],
    ["about_me", input.aboutMe],
    ["baseline", input.baseline],
    ["eating_and_drinking", input.eatingAndDrinking],
    ["capacity_and_legal", input.capacityAndLegal],
    ["infection", input.infection],
  ];
  const foreign = sourced
    .filter(([, source]) => source !== null && source.personId !== identity.personId)
    .map(([key]) => key);
  if (input.contacts.some((c) => c.personId !== identity.personId)) foreign.push("contacts");
  if (foreign.length > 0) return refuse("wrong_person", foreign);

  const allergies = normaliseAllergies(input.allergies.data);
  const medicines = normaliseMedicines(input.medicines.data);
  const communication = normaliseCommunication(input.communication.data);
  const resuscitation = normaliseResuscitation(input.resuscitation.data);
  const aboutMeSummary = input.aboutMe ? summariseAboutMe(input.aboutMe.data) : null;
  const reason = input.reasonForTransfer?.trim() ? input.reasonForTransfer.trim() : null;
  const itemsSent = input.property.filter((p) => input.sendItemIds.includes(p.id));
  const itemsLeftBehind = propertyToSendWithPerson(input.property).filter(
    (p) => !input.sendItemIds.includes(p.id),
  );

  const recorded: Record<TransferPackSectionKey, { included: boolean; asOf: Date | null }> = {
    photo: { included: input.photo !== null, asOf: input.photo?.asOf ?? null },
    allergies: { included: allergies.status !== "unknown", asOf: input.allergies.asOf },
    medicines: { included: medicines.status !== "not_recorded", asOf: input.medicines.asOf },
    communication: {
      included: communication.status !== "not_recorded",
      asOf: input.communication.asOf,
    },
    resuscitation: {
      included: resuscitation.status !== "not_recorded",
      asOf: input.resuscitation.asOf,
    },
    about_me: { included: aboutMeSummary?.hasContent === true, asOf: input.aboutMe?.asOf ?? null },
    reason_for_transfer: { included: reason !== null, asOf: input.generatedAt },
    baseline: {
      included: hasReason(input.baseline?.data.description, 1),
      asOf: input.baseline?.asOf ?? null,
    },
    eating_and_drinking: {
      included: input.eatingAndDrinking !== null,
      asOf: input.eatingAndDrinking?.asOf ?? null,
    },
    capacity_and_legal: {
      included: input.capacityAndLegal !== null,
      asOf: input.capacityAndLegal?.asOf ?? null,
    },
    contacts: { included: input.contacts.length > 0, asOf: null },
    infection: { included: input.infection !== null, asOf: input.infection?.asOf ?? null },
    items_sent: { included: true, asOf: input.generatedAt },
    home_contact: { included: input.homeContact !== null, asOf: null },
  };

  const sections: TransferPackSectionStatus[] = TRANSFER_PACK_SECTIONS.map((definition) => ({
    key: definition.key,
    title: definition.title,
    critical: definition.critical,
    hazardIds: definition.hazardIds,
    status: recorded[definition.key].included ? "included" : "not_recorded",
    asOf: recorded[definition.key].asOf,
  }));
  const missingCritical = sections
    .filter((s) => s.critical && s.status === "not_recorded")
    .map((s) => s.key);
  const missingExpected = sections
    .filter((s) => !s.critical && s.status === "not_recorded")
    .map((s) => s.key);

  return {
    ok: true,
    pack: {
      personId: identity.personId,
      generatedAt: input.generatedAt,
      generatedBy: input.generatedBy,
      identity,
      sections,
      content: {
        photo: input.photo?.data ?? null,
        allergies,
        medicines,
        communication,
        resuscitation,
        aboutMe:
          input.aboutMe && aboutMeSummary
            ? { document: input.aboutMe.data, summary: aboutMeSummary }
            : null,
        reasonForTransfer: reason,
        baseline: input.baseline?.data ?? null,
        eatingAndDrinking: input.eatingAndDrinking?.data ?? null,
        capacityAndLegal: input.capacityAndLegal?.data ?? null,
        contacts: input.contacts,
        infection: input.infection?.data ?? null,
        itemsSent,
        homeContact: input.homeContact,
      },
      missingCritical,
      missingExpected,
      itemsLeftBehind,
      complete: missingCritical.length === 0 && missingExpected.length === 0,
    },
  };
}

export const MIN_INCOMPLETE_PACK_REASON_LENGTH = 10;

export interface TransferPackAcknowledgement {
  readonly by: string;
  readonly at: Date;
  /** Why the pack went without the missing sections (for example "Emergency; allergies being confirmed with the GP"). */
  readonly reason: string;
}

export type TransferPackHandoverCheck =
  | { readonly ok: true; readonly incomplete: boolean }
  | {
      readonly ok: false;
      readonly problem: "acknowledgement_required" | "reason_required";
      readonly message: string;
      readonly missingCritical: readonly TransferPackSectionKey[];
    };

/**
 * Recording that the pack went with the person. A pack missing a safety-critical section can still
 * be printed and sent, but the hand-over is recorded only with a named acknowledgement and reason.
 */
export function checkTransferPackHandover(
  pack: HospitalTransferPack,
  acknowledgement: TransferPackAcknowledgement | null,
): TransferPackHandoverCheck {
  if (pack.missingCritical.length === 0) return { ok: true, incomplete: !pack.complete };
  if (!acknowledgement) {
    return {
      ok: false,
      problem: "acknowledgement_required",
      message:
        "Some safety-critical information is not recorded. Confirm that the pack is going without it, and why.",
      missingCritical: pack.missingCritical,
    };
  }
  if (!hasReason(acknowledgement.reason, MIN_INCOMPLETE_PACK_REASON_LENGTH)) {
    return {
      ok: false,
      problem: "reason_required",
      message: "Say why the pack is going without this information.",
      missingCritical: pack.missingCritical,
    };
  }
  return { ok: true, incomplete: true };
}

// ------------------------------------------------------------------------------------------------
// Return from hospital
// ------------------------------------------------------------------------------------------------

export interface ReturnCheckDefinition {
  readonly key: string;
  readonly title: string;
  readonly hazardIds: readonly string[];
}

/** Harbour's default checks on return from hospital; tenants add their own. */
export const RETURN_FROM_HOSPITAL_CHECKS: readonly ReturnCheckDefinition[] = [
  { key: "discharge_letter_filed", title: "Hospital discharge letter filed", hazardIds: [] },
  {
    key: "medicines_reconciled",
    title: "Medicines checked against the discharge letter",
    hazardIds: ["HZ-005"],
  },
  {
    key: "allergies_rechecked",
    title: "New allergies from the hospital recorded",
    hazardIds: ["HZ-007"],
  },
  {
    key: "resuscitation_rechecked",
    title: "Any resuscitation decision made in hospital recorded",
    hazardIds: ["HZ-015"],
  },
  {
    key: "eating_and_drinking_rechecked",
    title: "Any change to IDDSI levels from the hospital recorded",
    hazardIds: ["HZ-016"],
  },
  { key: "skin_checked", title: "Skin checked and body map updated", hazardIds: [] },
];

/** The checks to raise when a person returns, adding the belongings check if items went with them. */
export function returnFromHospitalChecks(
  property: readonly PropertyItemRecord[],
): readonly ReturnCheckDefinition[] {
  if (propertyAwayWithPerson(property).length === 0) return RETURN_FROM_HOSPITAL_CHECKS;
  return [
    ...RETURN_FROM_HOSPITAL_CHECKS,
    {
      key: "belongings_returned",
      title: "Belongings sent to hospital checked back in",
      hazardIds: [],
    },
  ];
}

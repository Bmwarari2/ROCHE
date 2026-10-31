import { z } from "zod";
import { StaffName } from "./staff";

/**
 * The residential people lifecycle (slice 8; master prompt 9.2; docs/specs/people.md sections 4
 * and 6): status changes, pre-admission and the decision to admit, admission and beds, the
 * welcome checklist, property and keys, About Me and its share links, reviews, hospital
 * transfers, exits, sharing decisions and the weekly break-glass report. Enumerations mirror
 * packages/domain (`people/*`); the API tests keep them in step. The API runs the domain checks
 * and answers 422 with their words, so the contracts stay lenient about completeness. Numbers use
 * inclusive bounds only.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const version = z.number().int().min(1);
const text = (max: number) => z.string().trim().max(max);

export const PersonStatus = z
  .enum([
    "enquiry",
    "pre_admission",
    "active",
    "on_leave",
    "in_hospital",
    "discharged",
    "deceased",
    "archived",
    "not_admitted",
  ])
  .meta({ id: "PersonStatus", description: "The person lifecycle (people.md rule 1)" });
export type PersonStatus = z.infer<typeof PersonStatus>;

export const PlacementType = z
  .enum(["permanent", "respite", "trial", "package"])
  .meta({ id: "PlacementType" });

// ------------------------------------------------------------------------------------------------
// Status changes (rules 1 to 3)
// ------------------------------------------------------------------------------------------------

export const ExitDetails = z
  .object({
    /** Death: where it happened, whether it was expected, and who verified it. */
    placeOfDeath: z.enum(["care_home", "hospital", "elsewhere"]).optional(),
    deathExpected: z.boolean().optional(),
    verifiedByName: text(200).optional(),
    verifiedByRole: text(120).optional(),
    verifiedAt: isoDateTime.optional(),
    presentAtDeath: text(500).optional(),
    funeralDirector: text(200).optional(),
    collectionAt: isoDateTime.optional(),
    coronerReferredBy: text(200).optional(),
    coronerReference: text(120).optional(),
    /** Discharge or transfer: where the person went, and the receiving provider. */
    destinationType: z
      .enum([
        "own_home",
        "family_home",
        "care_home",
        "hospital",
        "hospice",
        "supported_living",
        "other",
      ])
      .optional(),
    receivingProviderName: text(200).optional(),
    receivingProviderCqcLocationId: text(40).optional(),
    receivingProviderOdsCode: text(20).optional(),
    reason: text(1000).optional(),
    /** Needed for a death (LeDeR): an explicit answer, never assumed. */
    learningDisabilityOrAutism: z.boolean().optional(),
    /** Flags the exit checklist needs that the record cannot tell (people.md rule 12). */
    homeIsDwpAppointee: z.boolean().default(false),
    holdsResidentsMoney: z.boolean().default(false),
    holdsDeposit: z.boolean().default(false),
    hasLoanEquipment: z.boolean().default(false),
  })
  .meta({ id: "ExitDetails" });
export type ExitDetails = z.infer<typeof ExitDetails>;

/**
 * Records an enquiry: the first status of the lifecycle (rule 1), with the names and, when known,
 * the date of birth and NHS number. Nothing else is recorded until the pre-admission assessment.
 */
export const CreateEnquiry = z
  .object({
    locationId: uuid,
    givenName: text(100).min(1),
    familyName: text(100).min(1),
    preferredName: text(100).optional(),
    /**
     * On or after 1900-01-01 and not in the future. The contract allows a day's slack for time
     * zones; the API refuses a date after today in the UK.
     */
    dateOfBirth: isoDate
      .refine(
        (d) =>
          d >= "1900-01-01" && d <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
        {
          message: "A date of birth from 1900 onwards and not in the future",
        },
      )
      .optional(),
    /** Ten digits with a valid check digit; spaces are ignored. */
    nhsNumber: text(20).optional(),
  })
  .meta({ id: "CreateEnquiry" });
export type CreateEnquiry = z.infer<typeof CreateEnquiry>;

export const PersonStatusChange = z
  .object({
    to: PersonStatus,
    /** When it happened (left for hospital, died, left the service); not in the future. */
    effectiveAt: isoDateTime,
    reason: text(1000).optional(),
    /** For a discharge: `discharge` (home or elsewhere) or `transfer` to another provider. */
    exitKind: z.enum(["discharge", "transfer"]).optional(),
    exit: ExitDetails.optional(),
    /** For the start of a pre-admission assessment: what is being sought. */
    serviceId: uuid.optional(),
    placementTypeSought: PlacementType.optional(),
    /** The person record's version, as loaded. */
    version,
  })
  .meta({ id: "PersonStatusChange" });
export type PersonStatusChange = z.infer<typeof PersonStatusChange>;

export const PersonStatusChangeResult = z
  .object({
    personId: uuid,
    status: PersonStatus,
    statusChangedAt: isoDateTime,
    event: z.string(),
    effects: z.array(z.string()),
    correction: z.boolean(),
    exitRecordId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "PersonStatusChangeResult" });
export type PersonStatusChangeResult = z.infer<typeof PersonStatusChangeResult>;

export const UpdateCommunicationNeeds = z
  .object({
    needs: z
      .array(
        z.object({
          code: text(40).min(1),
          display: text(200).min(1),
          preferredFormat: text(200).optional(),
        }),
      )
      .max(30),
    /** `none_identified` is a positive statement and needs an empty list; `recorded` needs one. */
    status: z.enum(["none_identified", "recorded"]),
    version,
  })
  .meta({ id: "UpdateCommunicationNeeds" });
export type UpdateCommunicationNeeds = z.infer<typeof UpdateCommunicationNeeds>;

// ------------------------------------------------------------------------------------------------
// Pre-admission and the decision to admit (rules 4 and 5)
// ------------------------------------------------------------------------------------------------

export const PreAdmissionSectionKey = z
  .enum([
    "personal_details_and_contacts",
    "views_and_wishes",
    "health_and_medical_history",
    "medicines",
    "allergies",
    "communication",
    "mobility_and_falls",
    "eating_drinking_and_swallowing",
    "skin_integrity",
    "continence_and_personal_care",
    "cognition_and_mental_health",
    "capacity_and_legal_status",
    "resuscitation_and_advance_care",
    "infection_status",
    "equipment",
    "risks",
    "dependency",
    "funding",
    "social_cultural_and_spiritual",
    "hospital_passport",
  ])
  .meta({ id: "PreAdmissionSectionKey" });
export type PreAdmissionSectionKey = z.infer<typeof PreAdmissionSectionKey>;

export const InformationSource = z
  .enum([
    "person",
    "family_or_representative",
    "hospital",
    "gp",
    "social_worker",
    "previous_provider",
    "other",
  ])
  .meta({ id: "InformationSource" });

export const PreAdmissionMedicine = z
  .object({
    name: text(200).min(1),
    dose: text(120).min(1),
    route: text(60).min(1),
    frequency: text(120).min(1),
    /** Time-critical medicines (for example for Parkinson's disease) print first. */
    timeCritical: z.boolean().default(false),
  })
  .meta({ id: "PreAdmissionMedicine" });

export const PreAdmissionSectionInput = z
  .object({
    status: z.enum(["in_progress", "complete", "not_applicable"]),
    notes: text(4000).optional(),
    notApplicableReason: text(500).optional(),
    /** The medicines section only: the list, or none (an empty list on a complete section). */
    medicines: z.array(PreAdmissionMedicine).max(60).optional(),
  })
  .meta({ id: "PreAdmissionSectionInput" });

export const PreAdmissionSection = z
  .object({
    status: z.enum(["in_progress", "complete", "not_applicable"]),
    notes: z.string().nullable(),
    notApplicableReason: z.string().nullable(),
    medicines: z.array(PreAdmissionMedicine).nullable(),
    completedBy: uuid.nullable(),
    completedAt: isoDateTime.nullable(),
  })
  .meta({ id: "PreAdmissionSection" });
export type PreAdmissionSection = z.infer<typeof PreAdmissionSection>;

export const PersonInvolvement = z
  .union([
    z.object({ involved: z.literal(true) }),
    z.object({ involved: z.literal(false), reason: text(1000) }),
  ])
  .meta({ id: "PersonInvolvement", description: "Regulation 9: how the person took part" });

export const UpdatePreAdmission = z
  .object({
    sections: z.partialRecord(PreAdmissionSectionKey, PreAdmissionSectionInput).default({}),
    informationSources: z.array(InformationSource).max(7).optional(),
    personInvolvement: PersonInvolvement.optional(),
    serviceId: uuid.optional(),
    placementTypeSought: PlacementType.optional(),
    version,
  })
  .meta({ id: "UpdatePreAdmission" });
export type UpdatePreAdmission = z.infer<typeof UpdatePreAdmission>;

export const PreAdmissionAssessmentItem = z
  .object({
    id: uuid,
    personId: uuid,
    serviceId: uuid.nullable(),
    placementTypeSought: PlacementType.nullable(),
    status: z.enum(["in_progress", "complete", "decided"]),
    sections: z.partialRecord(PreAdmissionSectionKey, PreAdmissionSection),
    informationSources: z.array(InformationSource),
    personInvolvement: PersonInvolvement.nullable(),
    assessorTenantUserId: uuid.nullable(),
    completeness: z.object({
      complete: z.boolean(),
      outstanding: z.array(z.object({ key: PreAdmissionSectionKey, problem: z.string() })),
      sourcesMissing: z.boolean(),
      involvementMissing: z.boolean(),
      lastCompletedAt: isoDateTime.nullable(),
    }),
    version: z.number().int(),
  })
  .meta({ id: "PreAdmissionAssessmentItem" });
export type PreAdmissionAssessmentItem = z.infer<typeof PreAdmissionAssessmentItem>;

export const PreAdmissionView = z
  .object({
    assessment: PreAdmissionAssessmentItem.nullable(),
    definitions: z.array(
      z.object({
        key: PreAdmissionSectionKey,
        title: z.string(),
        required: z.boolean(),
        allowNotApplicable: z.boolean(),
        hazardIds: z.array(z.string()),
      }),
    ),
  })
  .meta({ id: "PreAdmissionView" });
export type PreAdmissionView = z.infer<typeof PreAdmissionView>;

export const CanMeetNeeds = z
  .enum(["yes", "yes_with_conditions", "no"])
  .meta({ id: "CanMeetNeeds" });

export const CreateAdmissionDecision = z
  .object({
    canMeetNeeds: CanMeetNeeds,
    reasons: text(4000),
    conditions: z.array(text(500)).max(20).default([]),
    plannedAdmissionOn: isoDate.optional(),
    trialEndsOn: isoDate.optional(),
    /** When the decision was made; now when left out. */
    decidedAt: isoDateTime.optional(),
    /** Who was told (the person, a representative, the referrer) and when. */
    toldWho: text(200).optional(),
    toldAt: isoDateTime.optional(),
    supersedesId: uuid.optional(),
    correctionReason: text(500).optional(),
  })
  .meta({ id: "CreateAdmissionDecision" });
export type CreateAdmissionDecision = z.infer<typeof CreateAdmissionDecision>;

export const AdmissionConditionItem = z
  .object({
    id: uuid,
    position: z.number().int(),
    condition: z.string(),
    metBy: uuid.nullable(),
    metAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "AdmissionConditionItem" });
export type AdmissionConditionItem = z.infer<typeof AdmissionConditionItem>;

export const AdmissionDecisionItem = z
  .object({
    id: uuid,
    personId: uuid,
    assessmentId: uuid,
    canMeetNeeds: CanMeetNeeds,
    admit: z.boolean(),
    reasons: z.string(),
    plannedAdmissionOn: isoDate.nullable(),
    trialEndsOn: isoDate.nullable(),
    decidedBy: uuid,
    decidedAt: isoDateTime,
    toldWho: z.string().nullable(),
    toldAt: isoDateTime.nullable(),
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    superseded: z.boolean(),
    conditions: z.array(AdmissionConditionItem),
  })
  .meta({ id: "AdmissionDecisionItem" });
export type AdmissionDecisionItem = z.infer<typeof AdmissionDecisionItem>;

export const AdmissionDecisionList = z
  .object({ items: z.array(AdmissionDecisionItem) })
  .meta({ id: "AdmissionDecisionList" });
export type AdmissionDecisionList = z.infer<typeof AdmissionDecisionList>;

export const ConfirmAdmissionCondition = z
  .object({ version })
  .meta({ id: "ConfirmAdmissionCondition" });

// ------------------------------------------------------------------------------------------------
// Admission, placements, beds and the welcome checklist (rules 5 and 6)
// ------------------------------------------------------------------------------------------------

export const PlacementItem = z
  .object({
    id: uuid,
    personId: uuid,
    serviceId: uuid,
    roomId: uuid.nullable(),
    type: PlacementType,
    startDate: isoDate,
    endDate: isoDate.nullable(),
    endReason: z.string().nullable(),
    trialEndsOn: isoDate.nullable(),
    trialReviewedOn: isoDate.nullable(),
    localAuthorityFunded: z.boolean(),
    nhsFunded: z.boolean(),
    admissionDecisionId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "PlacementItem" });
export type PlacementItem = z.infer<typeof PlacementItem>;

export const BedOccupancyItem = z
  .object({
    id: uuid,
    personId: uuid,
    roomId: uuid,
    roomLabel: z.string(),
    bed: z.number().int(),
    from: isoDate,
    /** The day the person left the bed (exclusive); null while they occupy it. */
    to: isoDate.nullable(),
    reason: z.string(),
    backdated: z.boolean(),
    recordedBy: uuid.nullable(),
    recordedAt: isoDateTime,
  })
  .meta({ id: "BedOccupancyItem" });
export type BedOccupancyItem = z.infer<typeof BedOccupancyItem>;

export const BedHistory = z
  .object({
    personId: uuid,
    /** The header's room label today, from this history (HZ-001). */
    roomLabel: z.string().nullable(),
    items: z.array(BedOccupancyItem),
  })
  .meta({ id: "BedHistory" });
export type BedHistory = z.infer<typeof BedHistory>;

export const CreateBedMove = z
  .object({
    roomId: uuid,
    bed: z.number().int().min(1).max(20).default(1),
    /** The day of the move in the location's calendar; never in the future. */
    on: isoDate,
    reason: text(500),
    /** The person record's version, as loaded. */
    version,
  })
  .meta({ id: "CreateBedMove" });
export type CreateBedMove = z.infer<typeof CreateBedMove>;

export const BedBoard = z
  .object({
    locationId: uuid,
    date: isoDate,
    rooms: z.array(
      z.object({
        roomId: uuid,
        label: z.string(),
        unitName: z.string().nullable(),
        status: z.enum(["available", "out_of_service", "awaiting_clearance"]),
        /** The room's version, for recording its clearance after a death (rule 6). */
        version: z.number().int(),
        beds: z.array(
          z.object({
            bed: z.number().int(),
            occupied: z.boolean(),
            /** Null when the bed is free, or when the occupant is outside your access. */
            personId: uuid.nullable(),
            name: z.string().nullable(),
            since: isoDate.nullable(),
          }),
        ),
      }),
    ),
  })
  .meta({ id: "BedBoard" });
export type BedBoard = z.infer<typeof BedBoard>;

export const WelcomeChecklistDefinitionItem = z
  .object({
    key: text(80).min(1),
    title: text(200).min(1),
    required: z.boolean(),
    safetyCritical: z.boolean(),
    allowNotApplicable: z.boolean(),
    hazardIds: z.array(z.string()).default([]),
  })
  .meta({ id: "WelcomeChecklistDefinitionItem" });

export const WelcomeChecklistTemplate = z
  .object({
    items: z.array(WelcomeChecklistDefinitionItem),
    /** True while the tenant uses Harbour's default checklist. */
    isDefault: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: "WelcomeChecklistTemplate" });
export type WelcomeChecklistTemplate = z.infer<typeof WelcomeChecklistTemplate>;

export const UpdateWelcomeChecklistTemplate = z
  .object({
    items: z.array(WelcomeChecklistDefinitionItem).min(1).max(60),
    /** 0 while the default is in use. */
    version: z.number().int().min(0),
  })
  .meta({ id: "UpdateWelcomeChecklistTemplate" });
export type UpdateWelcomeChecklistTemplate = z.infer<typeof UpdateWelcomeChecklistTemplate>;

export const WelcomeChecklistEntry = z
  .object({
    key: z.string(),
    title: z.string(),
    required: z.boolean(),
    safetyCritical: z.boolean(),
    allowNotApplicable: z.boolean(),
    status: z.enum(["pending", "done", "not_applicable"]),
    reason: z.string().nullable(),
    doneBy: uuid.nullable(),
    doneAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "WelcomeChecklistEntry" });

export const WelcomeChecklist = z
  .object({
    placementId: uuid.nullable(),
    items: z.array(WelcomeChecklistEntry),
    complete: z.boolean(),
    /** Required items not yet done, safety-critical ones first. */
    outstanding: z.array(z.string()),
    safetyCriticalOutstanding: z.array(z.string()),
    invalid: z.array(z.string()),
  })
  .meta({ id: "WelcomeChecklist" });
export type WelcomeChecklist = z.infer<typeof WelcomeChecklist>;

export const UpdateWelcomeChecklistItem = z
  .object({
    status: z.enum(["pending", "done", "not_applicable"]),
    reason: text(500).optional(),
    version,
  })
  .meta({ id: "UpdateWelcomeChecklistItem" });
export type UpdateWelcomeChecklistItem = z.infer<typeof UpdateWelcomeChecklistItem>;

export const RecordAdmission = z
  .object({
    serviceId: uuid,
    placementType: PlacementType,
    /** The first day of the placement (the location's calendar). */
    startDate: isoDate,
    trialEndsOn: isoDate.optional(),
    localAuthorityFunded: z.boolean().default(false),
    nhsFunded: z.boolean().default(false),
    dependencyCategory: text(20).optional(),
    /** The bed, for residential and nursing placements. */
    roomId: uuid.optional(),
    bed: z.number().int().min(1).max(20).default(1),
    /** When the person arrived. */
    admittedAt: isoDateTime,
    /** The person record's version, as loaded. */
    version,
  })
  .meta({ id: "RecordAdmission" });
export type RecordAdmission = z.infer<typeof RecordAdmission>;

export const AdmissionView = z
  .object({
    decision: AdmissionDecisionItem.nullable(),
    /** The conditions not yet confirmed as met. */
    conditionsOutstanding: z.array(z.string()),
    placement: PlacementItem.nullable(),
    welcomeChecklist: WelcomeChecklist,
  })
  .meta({ id: "AdmissionView" });
export type AdmissionView = z.infer<typeof AdmissionView>;

export const AdmissionResult = z
  .object({
    personId: uuid,
    status: PersonStatus,
    placement: PlacementItem,
    bed: BedOccupancyItem.nullable(),
    welcomeChecklist: WelcomeChecklist,
    version: z.number().int(),
  })
  .meta({ id: "AdmissionResult" });
export type AdmissionResult = z.infer<typeof AdmissionResult>;

// ------------------------------------------------------------------------------------------------
// Property, valuables and keys (rule 7)
// ------------------------------------------------------------------------------------------------

export const PropertyCategory = z
  .enum([
    "clothing",
    "jewellery",
    "watch",
    "electronics",
    "mobility_aid",
    "sensory_aid",
    "dentures",
    "documents",
    "furniture",
    "ornament_or_picture",
    "toiletries",
    "other",
  ])
  .meta({ id: "PropertyCategory" });

export const PropertySignature = z
  .object({
    signer: z.enum(["person", "representative", "unable_to_sign"]),
    /** The typed name of the person or representative who signed. */
    name: text(200).optional(),
    /** Why nobody could sign. */
    unableReason: text(500).optional(),
    signedAt: isoDateTime,
  })
  .meta({ id: "PropertySignature" });

export const CreatePropertyItem = z
  .object({
    /** Device-generated UUIDv7; a replayed request with the same id returns the first copy. */
    id: uuid.optional(),
    description: text(500),
    /** A category; anything naming cash is refused (residents' money is a ledger). */
    category: text(60),
    quantity: z.number().int().min(1).max(10000),
    valuable: z.boolean().default(false),
    photoDocumentIds: z.array(uuid).max(10).default([]),
    receivedOn: isoDate,
    acknowledgement: PropertySignature,
    /** A second member of staff, for valuables and items nobody could sign for. */
    witnessedBy: uuid.optional(),
  })
  .meta({ id: "CreatePropertyItem" });
export type CreatePropertyItem = z.infer<typeof CreatePropertyItem>;

export const PropertyItemOut = z
  .object({
    id: uuid,
    personId: uuid,
    description: z.string(),
    category: PropertyCategory,
    quantity: z.number().int(),
    /** True for valuable categories and anything marked valuable. */
    valuable: z.boolean(),
    photoDocumentIds: z.array(uuid),
    receivedOn: isoDate,
    recordedBy: uuid,
    acknowledgement: z.object({
      signer: z.enum(["person", "representative", "unable_to_sign"]),
      name: z.string().nullable(),
      unableReason: z.string().nullable(),
      signedAt: isoDateTime,
    }),
    witnessedBy: uuid.nullable(),
    status: z.enum(["held", "sent_with_person", "returned", "disposed", "lost"]),
    hospitalTransferId: uuid.nullable(),
    returned: z
      .object({
        on: isoDate,
        recipientName: z.string(),
        recipientCapacity: z.string(),
        signer: z.string(),
        signerName: z.string().nullable(),
        by: uuid,
        witnessedBy: uuid.nullable(),
      })
      .nullable(),
    disposed: z.object({ on: isoDate, reason: z.string(), by: uuid, witnessedBy: uuid }).nullable(),
    lost: z.object({ on: isoDate, incidentId: uuid }).nullable(),
    version: z.number().int(),
  })
  .meta({ id: "PropertyItemOut" });
export type PropertyItemOut = z.infer<typeof PropertyItemOut>;

export const PropertyList = z
  .object({
    items: z.array(PropertyItemOut),
    /** Held or away with the person: these block the exit from closing. */
    outstanding: z.array(uuid),
    /** Glasses, hearing aids, dentures and walking aids offered for the transfer pack. */
    toSendWithPerson: z.array(uuid),
  })
  .meta({ id: "PropertyList" });
export type PropertyList = z.infer<typeof PropertyList>;

export const ReturnPropertyItem = z
  .object({
    returnedOn: isoDate,
    recipientName: text(200),
    recipientCapacity: z.enum([
      "person",
      "representative",
      "personal_representative",
      "receiving_provider",
    ]),
    signature: PropertySignature,
    witnessedBy: uuid.optional(),
    version,
  })
  .meta({ id: "ReturnPropertyItem" });
export type ReturnPropertyItem = z.infer<typeof ReturnPropertyItem>;

export const DisposePropertyItem = z
  .object({ on: isoDate, reason: text(500), witnessedBy: uuid, version })
  .meta({ id: "DisposePropertyItem" });
export type DisposePropertyItem = z.infer<typeof DisposePropertyItem>;

export const LosePropertyItem = z
  .object({ on: isoDate, incidentId: uuid, version })
  .meta({ id: "LosePropertyItem" });
export type LosePropertyItem = z.infer<typeof LosePropertyItem>;

export const CreateKeyIssue = z
  .object({
    id: uuid.optional(),
    label: text(120).min(1),
    issuedOn: isoDate,
    issuedTo: z.enum(["person", "representative"]),
  })
  .meta({ id: "CreateKeyIssue" });
export type CreateKeyIssue = z.infer<typeof CreateKeyIssue>;

export const KeyIssueOut = z
  .object({
    id: uuid,
    personId: uuid,
    label: z.string(),
    issuedOn: isoDate,
    issuedTo: z.enum(["person", "representative"]),
    returnedOn: isoDate.nullable(),
    reportedLostOn: isoDate.nullable(),
    outstanding: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: "KeyIssueOut" });
export type KeyIssueOut = z.infer<typeof KeyIssueOut>;

export const KeyList = z.object({ items: z.array(KeyIssueOut) }).meta({ id: "KeyList" });
export type KeyList = z.infer<typeof KeyList>;

export const CloseKeyIssue = z
  .object({ on: isoDate, version })
  .meta({ id: "CloseKeyIssue", description: "The day the key came back, or was reported lost" });
export type CloseKeyIssue = z.infer<typeof CloseKeyIssue>;

// ------------------------------------------------------------------------------------------------
// About Me (rule 9) and share links
// ------------------------------------------------------------------------------------------------

export const AboutMeSectionContent = z
  .object({
    text: text(4000).nullable().optional(),
    /** Media is a reference to a document in the store, never inline. */
    media: z
      .array(z.object({ documentId: uuid, mimeType: text(100), filename: text(200).optional() }))
      .max(10)
      .optional(),
  })
  .meta({ id: "AboutMeSectionContent" });

const aboutMeSection = AboutMeSectionContent.nullable().optional();

/** PRSB About Me v2.01: the seven sections and the two record-level items (snake_case keys). */
export const AboutMeDocument = z
  .object({
    what_is_most_important_to_me: aboutMeSection,
    people_who_are_important_to_me: aboutMeSection,
    how_i_communicate: aboutMeSection,
    my_wellness: aboutMeSection,
    please_do_and_please_do_not: aboutMeSection,
    how_and_when_to_support_me: aboutMeSection,
    also_worth_knowing_about_me: aboutMeSection,
    supported_to_write_this_by: text(200).nullable().optional(),
    date_last_updated: z.string().nullable().optional(),
  })
  .loose()
  .meta({ id: "AboutMeDocument" });
export type AboutMeDocument = z.infer<typeof AboutMeDocument>;

export const UpdateAboutMe = z
  .object({
    sections: AboutMeDocument,
    /** True when the person wrote it themselves; otherwise name who supported them. */
    authoredByPerson: z.boolean(),
    /** 0 when there is no About Me yet. */
    version: z.number().int().min(0),
  })
  .meta({ id: "UpdateAboutMe" });
export type UpdateAboutMe = z.infer<typeof UpdateAboutMe>;

export const AboutMeOut = z
  .object({
    personId: uuid,
    sections: AboutMeDocument,
    authoredByPerson: z.boolean(),
    summary: z.object({
      filled: z.array(z.string()),
      missing: z.array(z.string()),
      dateLastUpdated: isoDateTime.nullable(),
      hasContent: z.boolean(),
    }),
    updatedAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "AboutMeOut" });
export type AboutMeOut = z.infer<typeof AboutMeOut>;

export const CreateAboutMeShareLink = z
  .object({ sharingDecisionId: uuid, expiresAt: isoDateTime })
  .meta({ id: "CreateAboutMeShareLink" });
export type CreateAboutMeShareLink = z.infer<typeof CreateAboutMeShareLink>;

export const AboutMeShareLinkOut = z
  .object({
    id: uuid,
    personId: uuid,
    sharingDecisionId: uuid,
    expiresAt: isoDateTime,
    revokedAt: isoDateTime.nullable(),
    revokedReason: z.string().nullable(),
    lastOpenedAt: isoDateTime.nullable(),
    createdBy: uuid.nullable(),
    createdAt: isoDateTime,
    /** Not revoked, not expired, and its sharing decision still in force. */
    active: z.boolean(),
  })
  .meta({ id: "AboutMeShareLinkOut" });
export type AboutMeShareLinkOut = z.infer<typeof AboutMeShareLinkOut>;

export const AboutMeShareLinkCreated = AboutMeShareLinkOut.extend({
  /** Shown once: only its SHA-256 hash is stored. */
  token: z.string(),
}).meta({ id: "AboutMeShareLinkCreated" });
export type AboutMeShareLinkCreated = z.infer<typeof AboutMeShareLinkCreated>;

export const AboutMeShareLinkList = z
  .object({ items: z.array(AboutMeShareLinkOut) })
  .meta({ id: "AboutMeShareLinkList" });
export type AboutMeShareLinkList = z.infer<typeof AboutMeShareLinkList>;

export const RevokeShareLink = z
  .object({ reason: text(500).min(3), version })
  .meta({ id: "RevokeShareLink" });
export type RevokeShareLink = z.infer<typeof RevokeShareLink>;

// ------------------------------------------------------------------------------------------------
// Reviews (rule 8)
// ------------------------------------------------------------------------------------------------

export const ReviewKind = z
  .enum([
    "first_care_plan",
    "care_plan_review",
    "care_plan_review_on_change",
    "la_review",
    "family_involvement",
    "trial_review",
  ])
  .meta({ id: "ReviewKind" });

export const ReviewRecordKind = z
  .enum(["care_plan", "la_review", "family_involvement", "trial_review"])
  .meta({ id: "ReviewRecordKind" });

export const FamilyInvolvementKind = z
  .enum([
    "attended_review",
    "contributed",
    "invited_declined",
    "person_declines_involvement",
    "no_family_or_representative",
  ])
  .meta({ id: "FamilyInvolvementKind" });

export const CarePlanChangeKind = z
  .enum([
    "return_from_hospital",
    "fall",
    "change_in_needs",
    "new_diagnosis",
    "safeguarding",
    "end_of_life",
    "other",
  ])
  .meta({ id: "CarePlanChangeKind" });

export const ReviewDue = z
  .object({
    kind: ReviewKind,
    dueOn: isoDate,
    windowOpensOn: isoDate.nullable(),
    dueAt: isoDateTime.nullable(),
    state: z.enum(["upcoming", "due", "overdue", "paused"]),
    changeIds: z.array(uuid),
    /** Rate-table keys the date comes from, shown with it. */
    basis: z.array(z.string()),
  })
  .meta({ id: "ReviewDue" });
export type ReviewDue = z.infer<typeof ReviewDue>;

export const ReviewRecordOut = z
  .object({
    id: uuid,
    personId: uuid,
    kind: ReviewRecordKind,
    heldOn: isoDate,
    participants: z.array(
      z.object({ role: z.string(), name: z.string().optional(), contactId: uuid.optional() }),
    ),
    familyInvolvementKind: FamilyInvolvementKind.nullable(),
    laReference: z.string().nullable(),
    changesCovered: z.array(uuid),
    outcome: z.string().nullable(),
    documentId: uuid.nullable(),
    supersedesId: uuid.nullable(),
    correctionReason: z.string().nullable(),
    superseded: z.boolean(),
    recordedBy: uuid.nullable(),
    recordedAt: isoDateTime,
  })
  .meta({ id: "ReviewRecordOut" });
export type ReviewRecordOut = z.infer<typeof ReviewRecordOut>;

export const CreateReviewRecord = z
  .object({
    kind: ReviewRecordKind,
    heldOn: isoDate,
    participants: z
      .array(
        z.object({
          role: text(120).min(1),
          name: text(200).optional(),
          contactId: uuid.optional(),
        }),
      )
      .max(30)
      .default([]),
    familyInvolvementKind: FamilyInvolvementKind.optional(),
    laReference: text(120).optional(),
    /** Care plan changes this review dealt with; a care plan review covers every open one by default. */
    changesCovered: z.array(uuid).max(100).optional(),
    outcome: text(4000).optional(),
    documentId: uuid.optional(),
    supersedesId: uuid.optional(),
    correctionReason: text(500).optional(),
  })
  .meta({ id: "CreateReviewRecord" });
export type CreateReviewRecord = z.infer<typeof CreateReviewRecord>;

export const CarePlanChangeOut = z
  .object({
    id: uuid,
    personId: uuid,
    kind: CarePlanChangeKind,
    occurredOn: isoDate,
    sourceType: z.string().nullable(),
    sourceId: uuid.nullable(),
    reviewedOn: isoDate.nullable(),
    reviewRecordId: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "CarePlanChangeOut" });
export type CarePlanChangeOut = z.infer<typeof CarePlanChangeOut>;

export const CreateCarePlanChange = z
  .object({
    kind: CarePlanChangeKind,
    occurredOn: isoDate,
    sourceType: z
      .enum(["incident", "hospital_transfer", "care_note", "assessment", "other"])
      .optional(),
    sourceId: uuid.optional(),
  })
  .meta({ id: "CreateCarePlanChange" });
export type CreateCarePlanChange = z.infer<typeof CreateCarePlanChange>;

export const CarePlanChangeList = z
  .object({ items: z.array(CarePlanChangeOut) })
  .meta({ id: "CarePlanChangeList" });
export type CarePlanChangeList = z.infer<typeof CarePlanChangeList>;

export const ReviewSchedule = z
  .object({
    personId: uuid,
    /** False when the location's nation has no review figures yet (Phase 7 nation packs). */
    available: z.boolean(),
    items: z.array(ReviewDue),
    familyInvolvement: z.enum([
      "scheduled",
      "person_declines_involvement",
      "no_family_or_representative",
      "not_receiving_care",
    ]),
    records: z.array(ReviewRecordOut),
    changes: z.array(CarePlanChangeOut),
  })
  .meta({ id: "ReviewSchedule" });
export type ReviewSchedule = z.infer<typeof ReviewSchedule>;

export const LocationReviews = z
  .object({
    locationId: uuid,
    items: z.array(ReviewDue.extend({ personId: uuid })),
  })
  .meta({ id: "LocationReviews" });
export type LocationReviews = z.infer<typeof LocationReviews>;

// ------------------------------------------------------------------------------------------------
// Hospital transfer pack (rule 10, HZ-023)
// ------------------------------------------------------------------------------------------------

export const TransferPackSection = z
  .object({
    key: z.string(),
    title: z.string(),
    critical: z.boolean(),
    hazardIds: z.array(z.string()),
    status: z.enum(["included", "not_recorded"]),
    asOf: isoDateTime.nullable(),
  })
  .meta({ id: "TransferPackSection" });

export const TransferPack = z
  .object({
    personId: uuid,
    generatedAt: isoDateTime,
    generatedBy: z.string(),
    identity: z.record(z.string(), z.unknown()),
    sections: z.array(TransferPackSection),
    /** What each section holds, copied from the record and never interpreted. */
    content: z.record(z.string(), z.unknown()),
    /** Safety-critical sections not recorded: printed as "not recorded" on the first page. */
    missingCritical: z.array(z.string()),
    missingExpected: z.array(z.string()),
    /**
     * Recorded but needing a check, printed on the first page: resuscitation records that disagree
     * (acknowledged at hand-over), an overdue resuscitation review, a medicines list from before
     * admission, a photo that cannot be printed, no known allergies without a confirmer.
     */
    attention: z
      .array(
        z.object({
          key: z.string(),
          code: z.enum([
            "resuscitation_conflict",
            "resuscitation_review_overdue",
            "medicines_need_checking",
            "photo_not_printable",
            "allergy_confirmation_not_recorded",
          ]),
          message: z.string(),
          acknowledge: z.boolean(),
          onDate: isoDate.nullable(),
        }),
      )
      .optional(),
    itemsLeftBehind: z.array(z.record(z.string(), z.unknown())),
    complete: z.boolean(),
  })
  .meta({ id: "TransferPack" });
export type TransferPack = z.infer<typeof TransferPack>;

export const PreviewTransferPack = z
  .object({
    /** Why the person is going to hospital (clinical free text: in the body, never the URL). */
    reason: text(2000).optional(),
    /** Glasses, hearing aids, dentures and walking aids going with the person. */
    sendItemIds: z.array(uuid).max(50).default([]),
  })
  .meta({ id: "PreviewTransferPack" });
export type PreviewTransferPack = z.infer<typeof PreviewTransferPack>;

export const CreateHospitalTransfer = z
  .object({
    /** Device-generated UUIDv7; a replayed request with the same id returns the first copy. */
    id: uuid.optional(),
    leftAt: isoDateTime,
    hospitalName: text(200).min(1),
    hospitalOdsCode: text(20).optional(),
    reason: text(2000).optional(),
    /** Glasses, hearing aids, dentures and walking aids going with the person. */
    sendItemIds: z.array(uuid).max(50).default([]),
    /** The person record's version, as loaded. */
    version,
  })
  .meta({ id: "CreateHospitalTransfer" });
export type CreateHospitalTransfer = z.infer<typeof CreateHospitalTransfer>;

export const HospitalTransferOut = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    leftAt: isoDateTime,
    hospitalName: z.string(),
    hospitalOdsCode: z.string().nullable(),
    reason: z.string().nullable(),
    pack: TransferPack,
    missingCritical: z.array(z.string()),
    missingExpected: z.array(z.string()),
    itemsSent: z.array(uuid),
    handedOverAt: isoDateTime.nullable(),
    handedOverBy: uuid.nullable(),
    acknowledgement: z.object({ by: uuid, at: isoDateTime, reason: z.string() }).nullable(),
    returnedAt: isoDateTime.nullable(),
    returnChecks: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        hazardIds: z.array(z.string()),
        doneBy: uuid.nullable(),
        doneAt: isoDateTime.nullable(),
        /** The task that carries the check (owner role, due time, escalation). */
        taskId: uuid.nullable().optional(),
        dueAt: isoDateTime.nullable().optional(),
      }),
    ),
    version: z.number().int(),
  })
  .meta({ id: "HospitalTransferOut" });
export type HospitalTransferOut = z.infer<typeof HospitalTransferOut>;

export const HospitalTransferList = z
  .object({ items: z.array(HospitalTransferOut) })
  .meta({ id: "HospitalTransferList" });
export type HospitalTransferList = z.infer<typeof HospitalTransferList>;

export const HandOverTransferPack = z
  .object({
    /** Needed when a safety-critical section is not recorded: why the pack went without it. */
    acknowledgementReason: text(1000).optional(),
    version,
  })
  .meta({ id: "HandOverTransferPack" });
export type HandOverTransferPack = z.infer<typeof HandOverTransferPack>;

export const RecordHospitalReturn = z
  .object({
    returnedAt: isoDateTime,
    /** The transfer's version, as loaded. */
    version,
  })
  .meta({ id: "RecordHospitalReturn" });
export type RecordHospitalReturn = z.infer<typeof RecordHospitalReturn>;

export const CompleteReturnCheck = z.object({ version }).meta({ id: "CompleteReturnCheck" });

// ------------------------------------------------------------------------------------------------
// Exits (rules 11 and 12)
// ------------------------------------------------------------------------------------------------

export const ExitState = z
  .enum(["planned", "left", "recorded", "awaiting_return", "closed", "cancelled"])
  .meta({ id: "ExitState" });

export const ExitChecklistEntry = z
  .object({
    key: z.string(),
    title: z.string(),
    owner: z.enum(["people", "care", "medicines", "safety", "finance"]),
    returnItem: z.boolean(),
    allowNotRequired: z.boolean(),
    notification: z
      .object({
        recipient: z.string(),
        statutory: z.boolean(),
        due: z.object({
          kind: z.enum(["without_delay", "before_leaving", "rate"]),
          rateKey: z.string().optional(),
        }),
      })
      .nullable(),
    hazardIds: z.array(z.string()),
    status: z.enum(["pending", "done", "not_required"]),
    reason: z.string().nullable(),
    doneBy: uuid.nullable(),
    doneAt: isoDateTime.nullable(),
    evidenceType: z.string().nullable(),
    evidenceId: uuid.nullable(),
    /** Counted from its own records (property, keys, money, statutory notifications). */
    derived: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: "ExitChecklistEntry" });

export const ExitOut = z
  .object({
    id: uuid,
    personId: uuid,
    kind: z.enum(["discharge", "transfer", "death"]),
    state: ExitState,
    leftAt: isoDateTime.nullable(),
    /**
     * The person's status when the exit was recorded: correcting a discharge or death recorded in
     * error returns them to it (`to` on the status change). Null for an exit only planned, or
     * recorded before it was kept (a correction then returns to active).
     */
    statusBefore: z.enum(["active", "on_leave", "in_hospital"]).nullable(),
    context: z.object({
      regulator: z.enum(["cqc", "ciw", "care_inspectorate", "rqia"]),
      localAuthorityFunded: z.boolean(),
      nhsFunded: z.boolean(),
      placeOfDeath: z.enum(["care_home", "hospital", "elsewhere"]).nullable(),
      deathExpected: z.boolean().nullable(),
      learningDisabilityOrAutism: z.boolean(),
      dolsInPlace: z.boolean(),
      homeIsDwpAppointee: z.boolean(),
      holdsResidentsMoney: z.boolean(),
      holdsDeposit: z.boolean(),
      hasLoanEquipment: z.boolean(),
    }),
    details: z.record(z.string(), z.unknown()),
    checklist: z.array(ExitChecklistEntry),
    status: z.object({
      readyForReturn: z.boolean(),
      readyToClose: z.boolean(),
      outstanding: z.array(z.string()),
      outstandingReturns: z.array(z.string()),
      invalid: z.array(z.string()),
    }),
    deadlines: z.object({
      moneyAndPropertyBy: isoDateTime.nullable(),
      depositBy: isoDateTime.nullable(),
    }),
    closedAt: isoDateTime.nullable(),
    cancelledReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "ExitOut" });
export type ExitOut = z.infer<typeof ExitOut>;

export const ExitView = z.object({ exit: ExitOut.nullable() }).meta({ id: "ExitView" });
export type ExitView = z.infer<typeof ExitView>;

export const PlanExit = z
  .object({
    kind: z.enum(["discharge", "transfer"]),
    details: ExitDetails.default({
      learningDisabilityOrAutism: false,
      homeIsDwpAppointee: false,
      holdsResidentsMoney: false,
      holdsDeposit: false,
      hasLoanEquipment: false,
    }),
  })
  .meta({ id: "PlanExit" });
export type PlanExit = z.infer<typeof PlanExit>;

export const UpdateExitItem = z
  .object({
    status: z.enum(["pending", "done", "not_required"]),
    reason: text(500).optional(),
    evidenceType: z.enum(["statutory_notification", "document", "ledger_entry", "note"]).optional(),
    evidenceId: uuid.optional(),
    version,
  })
  .meta({ id: "UpdateExitItem" });
export type UpdateExitItem = z.infer<typeof UpdateExitItem>;

export const MoveExit = z
  .object({
    to: z.enum(["awaiting_return", "closed", "cancelled"]),
    reason: text(1000).optional(),
    /** The exit record's version, as loaded. */
    version,
  })
  .meta({ id: "MoveExit" });
export type MoveExit = z.infer<typeof MoveExit>;

// ------------------------------------------------------------------------------------------------
// Sharing (rule 13, HZ-022)
// ------------------------------------------------------------------------------------------------

export const SharingSection = z
  .enum([
    "about_me",
    "daily_updates",
    "photos",
    "activities_and_visits",
    "care_plan",
    "health_summary",
    "medicines",
    "appointments",
    "finance",
    "benefits",
    "documents",
  ])
  .meta({ id: "SharingSection" });
export type SharingSection = z.infer<typeof SharingSection>;

export const SharingRecipient = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("family"), contactId: uuid }),
    z.object({ kind: z.literal("professional"), tenantUserId: uuid }),
    z.object({ kind: z.literal("link") }),
  ])
  .meta({ id: "SharingRecipient" });
export type SharingRecipient = z.infer<typeof SharingRecipient>;

export const SharingAuthority = z
  .object({
    role: z.enum([
      "lpa_health_welfare",
      "lpa_property_finance",
      "deputy_personal_welfare",
      "deputy_property_affairs",
      "appointee",
    ]),
    contactId: uuid,
    /** Taken from the contact's authority when left out. */
    reference: text(120).optional(),
    /** Taken from the contact's authority when left out. */
    evidenceDocumentId: uuid.optional(),
    /** Taken from the contact's authority when left out. */
    validUntil: isoDate.optional(),
    /**
     * For a deputy: the sections the Court of Protection order covers, as recorded from the order
     * (required for deputies, and within the deputyship the contact holds).
     */
    orderSections: z.array(SharingSection).min(1).max(11).optional(),
  })
  .meta({ id: "SharingAuthority" });

export const CreateSharingDecision = z
  .object({
    recipient: SharingRecipient,
    sections: z.array(SharingSection).min(1).max(11),
    /** Care plan domains shared when `care_plan` is a section; every domain when left out. */
    carePlanDomains: z.array(text(60)).max(20).optional(),
    basis: z.enum(["consent", "legal_authority", "best_interests", "direct_care"]),
    consentGivenBy: z.enum(["person", "authority_holder"]).optional(),
    capacity: z
      .enum(["presumed", "assessed_has_capacity", "assessed_lacks_capacity"])
      .default("presumed"),
    /**
     * The assessment of the person's capacity for this decision (an assessment of the sharing
     * decision, `decisionKind: "sharing"`), when it was assessed.
     */
    capacityAssessmentId: uuid.optional(),
    bestInterestsDecisionId: uuid.optional(),
    authority: SharingAuthority.optional(),
    validFrom: isoDateTime.optional(),
    /** Every decision expires. */
    validTo: isoDateTime,
  })
  .meta({ id: "CreateSharingDecision" });
export type CreateSharingDecision = z.infer<typeof CreateSharingDecision>;

export const SharingSuspensionOut = z
  .object({
    id: uuid,
    suspendedAt: isoDateTime,
    reason: z.string(),
    /** Empty while the suspension lasts. */
    liftedAt: isoDateTime.nullable(),
    liftedBy: uuid.nullable(),
    liftedReason: z.string().nullable(),
  })
  .meta({ id: "SharingSuspensionOut" });
export type SharingSuspensionOut = z.infer<typeof SharingSuspensionOut>;

export const SharingDecisionOut = z
  .object({
    id: uuid,
    personId: uuid,
    recipient: SharingRecipient,
    sections: z.array(SharingSection),
    carePlanDomains: z.array(z.string()).nullable(),
    basis: z.enum(["consent", "legal_authority", "best_interests", "direct_care"]),
    consentGivenBy: z.enum(["person", "authority_holder"]).nullable(),
    capacity: z.enum(["presumed", "assessed_has_capacity", "assessed_lacks_capacity"]),
    capacityAssessmentId: uuid.nullable(),
    bestInterestsDecisionId: uuid.nullable(),
    authority: SharingAuthority.nullable(),
    validFrom: isoDateTime,
    validTo: isoDateTime,
    withdrawnAt: isoDateTime.nullable(),
    withdrawnReason: z.string().nullable(),
    /** The suspension in force now, if any. */
    suspendedAt: isoDateTime.nullable(),
    suspendedReason: z.string().nullable(),
    /** Every period the decision was suspended, oldest first; what happened then stays closed. */
    suspensions: z.array(SharingSuspensionOut),
    /**
     * Started, not expired, not withdrawn or suspended, the person still receiving care and, for a
     * decision that rests on the person lacking capacity, the current finding still says so.
     */
    inForce: z.boolean(),
    recordedBy: uuid.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "SharingDecisionOut" });
export type SharingDecisionOut = z.infer<typeof SharingDecisionOut>;

export const SharingDecisionList = z
  .object({ items: z.array(SharingDecisionOut) })
  .meta({ id: "SharingDecisionList" });
export type SharingDecisionList = z.infer<typeof SharingDecisionList>;

export const CloseSharingDecision = z.object({ reason: text(1000).min(3), version }).meta({
  id: "CloseSharingDecision",
  description: "Withdraw, suspend or lift a suspension, with the reason",
});
export type CloseSharingDecision = z.infer<typeof CloseSharingDecision>;

export const SharingVisibility = z
  .object({
    personId: uuid,
    recipient: SharingRecipient,
    /**
     * The person's capacity for the sharing decision now, from the latest assessment of it
     * (presumed without one): a decision resting on a lack of capacity applies only while it is
     * `assessed_lacks_capacity`.
     */
    capacityForSharing: z.enum(["presumed", "assessed_has_capacity", "assessed_lacks_capacity"]),
    sections: z.array(
      z.object({
        section: SharingSection,
        visible: z.boolean(),
        decisionId: uuid.nullable(),
        expiresAt: isoDateTime.nullable(),
        reason: z.string().nullable(),
      }),
    ),
  })
  .meta({
    id: "SharingVisibility",
    description: "What one recipient may see now: closed unless a decision in force covers it",
  });
export type SharingVisibility = z.infer<typeof SharingVisibility>;

// ------------------------------------------------------------------------------------------------
// Weekly break-glass report (rule 14, PLAT-006, HZ-011)
// ------------------------------------------------------------------------------------------------

export const BreakGlassReasonCode = z
  .enum([
    "emergency_care",
    "covering_another_area",
    "safeguarding",
    "incident_or_complaint",
    "request_from_professional",
    "other",
  ])
  .meta({ id: "BreakGlassReasonCode" });

export const BreakGlassWeeklyReportOut = z
  .object({
    id: uuid,
    locationId: uuid,
    weekStart: isoDateTime,
    weekEnd: isoDateTime,
    generatedAt: isoDateTime,
    repeatThreshold: z.number().int(),
    /** Totals, lines by user, person and reason, unreviewed openings and flags: opaque ids only. */
    summary: z.record(z.string(), z.unknown()),
    reviewedBy: uuid.nullable(),
    reviewedAt: isoDateTime.nullable(),
    actionsTaken: z.string().nullable(),
    supersedesId: uuid.nullable(),
    /**
     * The staff the report names (the user lines, the flags, the searchers and the reviewer), by
     * display name and job title for attribution, since a reader such as the data protection lead
     * may not list the organisation's members. Never an address or a reason.
     */
    staff: z.array(StaffName),
  })
  .meta({ id: "BreakGlassWeeklyReportOut" });
export type BreakGlassWeeklyReportOut = z.infer<typeof BreakGlassWeeklyReportOut>;

export const BreakGlassWeeklyReportList = z
  .object({
    weekStart: isoDateTime,
    weekEnd: isoDateTime,
    items: z.array(BreakGlassWeeklyReportOut),
  })
  .meta({ id: "BreakGlassWeeklyReportList" });
export type BreakGlassWeeklyReportList = z.infer<typeof BreakGlassWeeklyReportList>;

export const ReviewBreakGlassReport = z
  .object({ actionsTaken: text(2000).min(3) })
  .meta({ id: "ReviewBreakGlassReport" });
export type ReviewBreakGlassReport = z.infer<typeof ReviewBreakGlassReport>;

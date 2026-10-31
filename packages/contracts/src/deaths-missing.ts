import { z } from "zod";

/**
 * Deaths and missing persons (Phase 2 slice 37; SAFE-014, SAFE-015; safety.md slice 37). Codes
 * mirror packages/domain (`safety/death-record.ts`, `safety/missing-episode.ts`); the API tests
 * keep them in step.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const version = z.number().int().min(1);
const upsertVersion = z.number().int().min(0);
const text = (max: number) => z.string().trim().max(max);

export const DeathStep = z
  .enum([
    "verification_of_death",
    "family_informed",
    "medical_examiner_pack",
    "cqc_reg16_notification",
    "leder_notification",
    "police_informed",
    "preserve_room_and_equipment",
    "mortality_review",
  ])
  .meta({ id: "DeathStep" });
export const DeathRecordStatus = z
  .enum(["open", "closed", "withdrawn"])
  .meta({ id: "DeathRecordStatus" });
export const DeathStepOutcome = z.enum(["done", "not_needed"]).meta({ id: "DeathStepOutcome" });
export const DeathStepState = z
  .enum(["done", "not_needed", "waiting", "outstanding"])
  .meta({ id: "DeathStepState" });

export const DeathSummary = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    diedAt: isoDateTime,
    status: DeathRecordStatus,
    reviewDueAt: isoDateTime,
    reviewOverdue: z.boolean(),
    /** Steps not yet done or decided not needed, the mortality review included. */
    outstanding: z.number().int().min(0),
    version,
  })
  .meta({ id: "DeathSummary" });
export type DeathSummary = z.infer<typeof DeathSummary>;

export const DeathList = z
  .object({ items: z.array(DeathSummary), truncated: z.boolean() })
  .meta({ id: "DeathList" });
export type DeathList = z.infer<typeof DeathList>;

export const DeathView = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    exitRecordId: uuid,
    incidentId: uuid.nullable(),
    diedAt: isoDateTime,
    expected: z.boolean().nullable(),
    possiblyUnnatural: z.boolean().nullable(),
    judgedBy: z.string().nullable(),
    learningDisabilityOrAutism: z.boolean(),
    status: DeathRecordStatus,
    /** The judgement not yet recorded: the steps assume the safer answer until it is. */
    missingFacts: z.array(z.enum(["expected", "possiblyUnnatural"])),
    steps: z.array(
      z.object({
        step: DeathStep,
        state: DeathStepState,
        at: isoDateTime.nullable(),
        /** For a notification step: the notification's id and status, or null when none was drafted. */
        notificationId: uuid.nullable(),
        notificationStatus: z.enum(["draft", "ready", "submitted", "not_required"]).nullable(),
        reason: z.string().nullable(),
      }),
    ),
    history: z.array(
      z.object({
        id: uuid,
        step: DeathStep,
        outcome: DeathStepOutcome,
        at: isoDateTime,
        note: z.string().nullable(),
        reference: z.string().nullable(),
        recordedAt: isoDateTime,
        recordedBy: uuid.nullable(),
      }),
    ),
    review: z.object({
      dueAt: isoDateTime,
      overdue: z.boolean(),
      findings: z.string().nullable(),
      lessons: z.string().nullable(),
      reviewedAt: isoDateTime.nullable(),
      reviewedBy: uuid.nullable(),
    }),
    closeProblems: z.array(z.string()),
    closedAt: isoDateTime.nullable(),
    withdrawnReason: z.string().nullable(),
    version,
  })
  .meta({ id: "DeathView" });
export type DeathView = z.infer<typeof DeathView>;

export const OpenDeath = z.object({ exitRecordId: uuid }).meta({ id: "OpenDeath" });

/** The clinician's judgement, with whose judgement it records. */
export const DeathJudgement = z
  .object({
    expected: z.boolean(),
    possiblyUnnatural: z.boolean(),
    judgedBy: text(200).min(3),
    version,
  })
  .meta({ id: "DeathJudgement" });

export const RecordDeathStep = z
  .object({
    /** The client's id: sending it again is a no-op. */
    id: uuid,
    step: DeathStep,
    outcome: DeathStepOutcome,
    at: isoDateTime,
    note: text(2000).min(1).nullable().optional(),
    reference: text(100).min(1).nullable().optional(),
  })
  .meta({ id: "RecordDeathStep" });

export const DeathReview = z
  .object({ findings: text(10000), lessons: text(10000), version })
  .meta({ id: "DeathReview" });

export const CloseDeath = z.object({ version }).meta({ id: "CloseDeath" });

export const MissingTimelineKind = z
  .enum([
    "last_seen",
    "noticed_missing",
    "search_started",
    "search",
    "sighting",
    "police_called",
    "found",
    "welfare_check",
    "debrief",
    "note",
  ])
  .meta({ id: "MissingTimelineKind" });
export const MissingEpisodeStatus = z
  .enum(["open", "found", "closed"])
  .meta({ id: "MissingEpisodeStatus" });
export const HerbertProfileState = z
  .enum(["none", "current", "out_of_date"])
  .meta({ id: "HerbertProfileState" });

export const MissingEpisodeSummary = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    incidentId: uuid,
    status: MissingEpisodeStatus,
    noticedMissingAt: isoDateTime.nullable(),
    policeCallDueAt: isoDateTime.nullable(),
    policeCallLate: z.boolean(),
    version,
  })
  .meta({ id: "MissingEpisodeSummary" });

export const MissingEpisodeList = z
  .object({ items: z.array(MissingEpisodeSummary), truncated: z.boolean() })
  .meta({ id: "MissingEpisodeList" });
export type MissingEpisodeList = z.infer<typeof MissingEpisodeList>;

export const MissingEpisodeView = z
  .object({
    id: uuid,
    personId: uuid,
    locationId: uuid,
    incidentId: uuid,
    status: MissingEpisodeStatus,
    immediateRisk: z.boolean(),
    underDolsOrMha: z.boolean(),
    timeline: z.array(
      z.object({
        id: uuid,
        kind: MissingTimelineKind,
        at: isoDateTime,
        reference: z.string().nullable(),
        area: z.string().nullable(),
        note: z.string().nullable(),
        recordedAt: isoDateTime,
        recordedBy: uuid.nullable(),
      }),
    ),
    policeCallDueAt: isoDateTime.nullable(),
    policeCallLate: z.boolean(),
    policeReference: z.string().nullable(),
    /** Police involved, or the person is under DoLS or the Mental Health Act (regulation 18(2)(f)). */
    cqcNotificationPrompt: z.boolean(),
    herbertProfile: HerbertProfileState,
    herbertProfileVersionAtOpening: z.number().int().nullable(),
    /** The incident's notifications that this episode prompts, as the notification centre has them. */
    notifications: z.array(
      z.object({
        id: uuid,
        kind: z.string(),
        status: z.enum(["draft", "ready", "submitted", "not_required"]),
      }),
    ),
    closeProblems: z.array(z.string()),
    canClose: z.boolean(),
    closedAt: isoDateTime.nullable(),
    version,
  })
  .meta({ id: "MissingEpisodeView" });
export type MissingEpisodeView = z.infer<typeof MissingEpisodeView>;

export const OpenMissingEpisode = z
  .object({
    /** The client's id: sending it again is a no-op. */
    id: uuid,
    incidentId: uuid,
    personId: uuid,
    /** The organisation's risk assessment says call the police at once. */
    immediateRisk: z.boolean(),
    noticedMissingAt: isoDateTime,
    lastSeenAt: isoDateTime.nullable().optional(),
  })
  .meta({ id: "OpenMissingEpisode" });

export const MissingTimelineEntry = z
  .object({
    /** The client's id: sending it again is a no-op. */
    id: uuid,
    kind: MissingTimelineKind,
    at: isoDateTime,
    reference: text(100).min(1).nullable().optional(),
    area: text(500).min(1).nullable().optional(),
    note: text(4000).min(1).nullable().optional(),
  })
  .meta({ id: "MissingTimelineEntry" });

export const CloseMissingEpisode = z.object({ version }).meta({ id: "CloseMissingEpisode" });

const profileText = (max: number) => text(max).nullable();

export const HerbertProfileFields = z
  .object({
    photoDocumentId: uuid.nullable(),
    physicalDescription: text(4000),
    distinguishingFeatures: profileText(4000),
    usualClothing: profileText(4000),
    medicalNeeds: profileText(4000),
    mobility: profileText(4000),
    communication: profileText(4000),
    placesLikely: text(4000),
    peopleLikely: profileText(4000),
    routines: profileText(4000),
    phoneOrTracker: profileText(1000),
    previousEpisodes: profileText(4000),
    approach: profileText(4000),
    reviewedWith: profileText(500),
  })
  .meta({ id: "HerbertProfileFields" });

export const SaveHerbertProfile = HerbertProfileFields.extend({
  reviewedOn: isoDate,
  version: upsertVersion,
  /**
   * A first profile when the record prefills any part: true once staff have checked each
   * prefilled part with the person or their family (HZ-127). Not stored.
   */
  prefillChecked: z.boolean().optional(),
}).meta({ id: "SaveHerbertProfile" });

export const HerbertProfileView = z
  .object({
    personId: uuid,
    profile: HerbertProfileFields.extend({
      id: uuid,
      reviewedOn: isoDate,
      reviewedBy: uuid,
      version,
    }).nullable(),
    state: HerbertProfileState,
    /** When the profile falls out of date (UK date); null with no profile. */
    reviewDueOn: isoDate.nullable(),
    /**
     * A new profile prefilled from the person's record, for staff to check before saving: every
     * part says where it came from; what the person looks like is never prefilled.
     */
    prefill: HerbertProfileFields.omit({ physicalDescription: true, placesLikely: true }).extend({
      physicalDescription: z.string().nullable(),
      placesLikely: z.string().nullable(),
    }),
  })
  .meta({ id: "HerbertProfileView" });
export type HerbertProfileView = z.infer<typeof HerbertProfileView>;

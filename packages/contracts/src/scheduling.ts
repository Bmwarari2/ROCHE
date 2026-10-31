import { z } from "zod";

/**
 * The dependency tool and required care hours (scheduling.md section 12; CARE-004, SCHED-001;
 * hazard HZ-123). The scale is the organisation's own tool: every figure in it is theirs, and
 * every required-hours result names it as the source with `notice`. Nothing here is a score.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const key = z.string().trim().min(1).max(40);
const label = z.string().trim().max(80);
const minutes = z.number().int().min(0).max(2880);

export const StaffingSkill = z
  .enum(["registered_nurse", "medicines_competent", "moving_and_handling", "driver"])
  .meta({ id: "StaffingSkill" });

export const PeriodMinutes = z
  .object({ periodKey: key, minutes })
  .meta({ id: "PeriodMinutes", description: "Minutes in one of the scale's shift periods" });

export const DependencyScaleDefinition = z
  .object({
    /** Shift periods in the order they start; each ends where the next starts. */
    periods: z
      .array(z.object({ key, label, startMinute: z.number().int().min(0).max(1439) }))
      .max(12),
    categories: z
      .array(
        z.object({
          key,
          label,
          description: z.string().trim().max(500).nullable(),
          /** Care minutes per person in each period. */
          careMinutes: z.array(PeriodMinutes).max(12),
        }),
      )
      .max(30),
    /** The organisation's minimum staff with each skill on a period. */
    skillMix: z
      .array(
        z.object({
          skill: StaffingSkill,
          periodKey: key,
          minimumStaff: z.number().int().min(0).max(100),
        }),
      )
      .max(60),
    reviewIntervalDays: z.number().int().min(0).max(3650).nullable(),
  })
  .meta({
    id: "DependencyScaleDefinition",
    description:
      "The organisation's own dependency scale: its shift periods, categories with care minutes per period, skill-mix minimums and review interval",
  });
export type DependencyScaleDefinition = z.infer<typeof DependencyScaleDefinition>;

export const DependencyScaleIssue = z
  .object({ problem: z.string(), path: z.string(), message: z.string() })
  .meta({ id: "DependencyScaleIssue" });

export const DependencyScaleState = z
  .enum(["draft", "approved", "superseded", "discarded"])
  .meta({ id: "DependencyScaleState" });

export const DependencyScaleVersionItem = z
  .object({
    id: uuid,
    scaleId: uuid,
    versionNumber: z.number().int(),
    state: DependencyScaleState,
    definition: DependencyScaleDefinition,
    authorId: uuid,
    contributorIds: z.array(uuid),
    approvedBy: uuid.nullable(),
    approvedAt: isoDateTime.nullable(),
    supersededAt: isoDateTime.nullable(),
    discardReason: z.string().nullable(),
    /** Problems with the definition; a draft needs none to be approved. */
    issues: z.array(DependencyScaleIssue),
    version,
  })
  .meta({ id: "DependencyScaleVersionItem" });

export const DependencyScaleItem = z
  .object({
    id: uuid,
    /** Null for the organisation-wide scale, used where a location has none of its own. */
    locationId: uuid.nullable(),
    name: z.string(),
    archivedAt: isoDateTime.nullable(),
    archiveReason: z.string().nullable(),
    current: DependencyScaleVersionItem.nullable(),
    draft: DependencyScaleVersionItem.nullable(),
    version,
  })
  .meta({ id: "DependencyScaleItem" });

export const DependencyScaleList = z
  .object({ items: z.array(DependencyScaleItem), notice: z.string() })
  .meta({ id: "DependencyScaleList" });

export const DependencyScaleVersionList = z
  .object({ items: z.array(DependencyScaleVersionItem) })
  .meta({ id: "DependencyScaleVersionList" });

export const CreateDependencyScale = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** The location; null for the organisation-wide scale. */
    locationId: uuid.nullable(),
    definition: DependencyScaleDefinition,
  })
  .meta({ id: "CreateDependencyScale" });

export const RenameDependencyScale = z
  .object({ name: z.string().trim().min(1).max(120), version })
  .meta({ id: "RenameDependencyScale" });

export const EndDependencyScale = z
  .object({ reason: z.string().trim().min(3).max(500), version })
  .meta({ id: "EndDependencyScale", description: "Archive a scale or discard a draft, with why" });

export const EditDependencyScaleVersion = z
  .object({ definition: DependencyScaleDefinition, version })
  .meta({ id: "EditDependencyScaleVersion" });

export const ApproveDependencyScaleVersion = z
  .object({ version })
  .meta({ id: "ApproveDependencyScaleVersion" });

export const DependencyKind = z
  .enum(["initial", "review", "correction"])
  .meta({ id: "DependencyKind" });

export const RecordDependency = z
  .object({
    /** The client's id for the record: sending it again returns what was stored. */
    id: uuid,
    kind: DependencyKind,
    categoryKey: key,
    oneToOne: z.array(PeriodMinutes).max(12).default([]),
    /** The UK date the category applies from (today or earlier). */
    effectiveFrom: isoDate,
    reason: z.string().trim().min(1).max(2000),
    /** The member of staff who decided the category. */
    decidedBy: uuid,
    /** The person's current record, as loaded; null for their first. */
    supersedesId: uuid.nullable(),
  })
  .meta({ id: "RecordDependency" });
export type RecordDependency = z.infer<typeof RecordDependency>;

export const DependencyRecordItem = z
  .object({
    id: uuid,
    personId: uuid,
    scaleId: uuid,
    scaleVersionId: uuid,
    versionNumber: z.number().int().nullable(),
    categoryKey: z.string(),
    /** The category's name in the version it was recorded on. */
    categoryLabel: z.string().nullable(),
    oneToOne: z.array(PeriodMinutes),
    kind: DependencyKind,
    effectiveFrom: isoDate,
    reason: z.string(),
    decidedBy: uuid,
    recordedBy: uuid.nullable(),
    recordedAt: isoDateTime,
    supersedesId: uuid.nullable(),
    /** True for the record in force now. */
    inForce: z.boolean(),
    /** True when a correction replaced it: shown struck through, never in force. */
    corrected: z.boolean(),
  })
  .meta({ id: "DependencyRecordItem" });

export const PersonDependency = z
  .object({
    /** The record in force now, if any. */
    inForce: DependencyRecordItem.nullable(),
    /** The record a new one must supersede (the chain's head); null before the first. */
    currentId: uuid.nullable(),
    /** Every record, newest first. */
    items: z.array(DependencyRecordItem),
    notice: z.string(),
    /**
     * The free-text category from the Phase 1 admission form, retired (H-716): shown read-only to
     * whoever records the first category so nothing is lost, never prefilled into it. Null once a
     * category has been recorded, or when none was written.
     */
    admissionFormCategory: z.string().nullable(),
  })
  .meta({ id: "PersonDependency" });

const RequirementPeriod = z.object({
  key: z.string(),
  label: z.string(),
  start: isoDateTime,
  end: isoDateTime,
  /** Elapsed minutes: an hour more or less on the nights the clocks change. */
  minutes: z.number(),
});

export const StaffingRequirementItem = z
  .object({
    /** `no_scale`: no scale in force, so no figure (never 0). */
    status: z.enum(["computed", "no_scale"]),
    locationId: uuid,
    date: isoDate,
    period: RequirementPeriod.nullable(),
    /** The organisation's own scale the figures come from. */
    source: z
      .object({
        kind: z.literal("organisation_scale"),
        scaleId: uuid,
        scaleName: z.string(),
        versionId: uuid,
        versionNumber: z.number().int(),
        approvedBy: uuid.nullable(),
        approvedAt: isoDateTime.nullable(),
      })
      .nullable(),
    notice: z.string(),
    /**
     * `exact` when everyone who may be at the location is counted; `at_least` when someone is
     * left out, so the hours may be higher; `none` when nobody is counted (no figure).
     */
    figure: z.enum(["exact", "at_least", "none"]),
    careMinutes: z.number().nullable(),
    oneToOneMinutes: z.number().nullable(),
    /** A lower bound when `figure` is `at_least`; null when `none` or with no scale. */
    requiredMinutes: z.number().nullable(),
    /** What people on leave or in hospital would add; not in `requiredMinutes`. */
    awayMinutes: z.number().nullable(),
    categories: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        minutesEach: z.number(),
        people: z.number().int(),
        minutes: z.number(),
      }),
    ),
    oneToOne: z.array(z.object({ personId: uuid, minutes: z.number() })),
    people: z.array(
      z.object({
        personId: uuid,
        /** Where the person is on the date asked, from their record (rule 9). */
        presence: z.enum([
          "present",
          "planned_admission",
          "away",
          "away_return_unknown",
          "admission_date_unknown",
          "not_yet_admitted",
          "unknown",
        ]),
        standing: z.enum(["assessed", "not_assessed", "other_scale", "not_in_scale_version"]),
        recordId: uuid.nullable(),
        categoryKey: z.string().nullable(),
        categoryLabel: z.string().nullable(),
        careMinutes: z.number(),
        oneToOneMinutes: z.number(),
        flags: z.array(z.enum(["earlier_version", "later_version", "review_overdue"])),
      }),
    ),
    skillMix: z.array(z.object({ skill: StaffingSkill, minimumStaff: z.number().int() })),
    /** False when someone at the location is not counted: the hours may be higher. */
    complete: z.boolean(),
    warnings: z.array(
      z.object({ code: z.string(), message: z.string(), personIds: z.array(uuid) }),
    ),
    /** The working, step by step, in words. */
    method: z.array(z.string()),
  })
  .meta({ id: "StaffingRequirementItem" });

export const StaffingRequirementList = z
  .object({
    items: z.array(StaffingRequirementItem),
    /** When the people at the location were read. */
    asAt: isoDateTime,
  })
  .meta({ id: "StaffingRequirementList" });

import { z } from "zod";
import { StaffingSkill } from "./scheduling";
import { Competence } from "./workforce";

/**
 * The rota builder (scheduling.md section 14; SCHED-001, SCHED-002; hazards HZ-123 and HZ-124):
 * shift templates and patterns, rotas, shifts, assignments with the rostering rule, and the
 * pre-publish check (the staffing comparison with the organisation's own dependency scale, the
 * working time findings and every assignment's eligibility again). The comparison and the working
 * time check advise; only the rostering rule blocks, and a manager may override it except for a
 * right to work.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const minuteOfDay = z.number().int().min(0).max(1439);
const name = z.string().trim().min(1).max(80);
const reason = z.string().trim().min(1).max(500);

/** Product limits: a rota covers at most six weeks; a pattern's cycle at most eight. */
export const ROTA_MAX_DAYS = 42;
export const PATTERN_MAX_CYCLE_DAYS = 56;

export const ShiftKind = z
  .enum(["work", "sleep_in", "on_call_at_workplace", "on_call_away", "training"])
  .meta({ id: "ShiftKind" });

const ShiftShapeFields = {
  kind: ShiftKind,
  /** UK wall-clock minutes after midnight (24-hour); an end at or before the start is the next day. */
  startMinute: minuteOfDay,
  endMinute: minuteOfDay,
  breakMinutes: z.number().int().min(0).max(240),
  requiredCompetences: z.array(Competence).max(8).default([]),
  requiredSkills: z.array(StaffingSkill).max(4).default([]),
  supervised: z.boolean().default(false),
  /** The organisation counts it as care on the floor (false for housekeeping, kitchen, office). */
  countsAsCare: z.boolean().default(true),
};

export const CreateShiftTemplate = z
  .object({ name, ...ShiftShapeFields })
  .meta({ id: "CreateShiftTemplate" });

export const ShiftTemplateItem = z
  .object({
    id: uuid,
    version,
    locationId: uuid,
    name: z.string(),
    kind: ShiftKind,
    startMinute: z.number().int(),
    endMinute: z.number().int(),
    breakMinutes: z.number().int(),
    requiredCompetences: z.array(z.string()),
    requiredSkills: z.array(StaffingSkill),
    supervised: z.boolean(),
    countsAsCare: z.boolean(),
  })
  .meta({ id: "ShiftTemplateItem" });

export const ShiftTemplateList = z
  .object({ items: z.array(ShiftTemplateItem) })
  .meta({ id: "ShiftTemplateList" });

export const ArchiveRotaItem = z
  .object({ version, reason: reason.optional() })
  .meta({ id: "ArchiveRotaItem" });

export const PatternEntry = z
  .object({
    day: z
      .number()
      .int()
      .min(0)
      .max(PATTERN_MAX_CYCLE_DAYS - 1),
    templateId: uuid,
    count: z.number().int().min(1).max(20),
  })
  .meta({ id: "PatternEntry" });

export const CreateShiftPattern = z
  .object({
    name,
    cycleDays: z.number().int().min(1).max(PATTERN_MAX_CYCLE_DAYS),
    entries: z.array(PatternEntry).min(1).max(200),
  })
  .meta({ id: "CreateShiftPattern" });

export const ShiftPatternItem = z
  .object({
    id: uuid,
    version,
    locationId: uuid,
    name: z.string(),
    cycleDays: z.number().int(),
    entries: z.array(PatternEntry),
  })
  .meta({ id: "ShiftPatternItem" });

export const ShiftPatternList = z
  .object({ items: z.array(ShiftPatternItem) })
  .meta({ id: "ShiftPatternList" });

export const CreateRota = z
  .object({ startsOn: isoDate, endsOn: isoDate })
  .meta({ id: "CreateRota" });

const StaffMember = z.object({
  id: uuid,
  displayName: z.string(),
  jobTitle: z.string().nullable(),
});

export const AssignmentItem = z
  .object({
    id: uuid,
    version,
    worker: StaffMember,
    publishedAt: isoDateTime.nullable(),
    /** The blockers a manager's override covered, as `blockerKey`s; empty when none. */
    overridden: z.array(z.string()),
    /**
     * HZ-123: the member is away (an approved or recorded absence) on the shift, so it needs
     * cover and the staffing comparison does not count them. Never says why.
     */
    coverNeeded: z.boolean(),
  })
  .meta({ id: "AssignmentItem" });

export const ShiftItem = z
  .object({
    id: uuid,
    version,
    rotaId: uuid,
    templateId: uuid.nullable(),
    label: z.string(),
    kind: ShiftKind,
    date: isoDate,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    breakMinutes: z.number().int(),
    requiredCompetences: z.array(z.string()),
    requiredSkills: z.array(StaffingSkill),
    supervised: z.boolean(),
    countsAsCare: z.boolean(),
    publishedAt: isoDateTime.nullable(),
    changedAfterPublishAt: isoDateTime.nullable(),
    /** Null: an open shift. */
    assignment: AssignmentItem.nullable(),
  })
  .meta({ id: "ShiftItem" });

export const RotaItem = z
  .object({
    id: uuid,
    version,
    locationId: uuid,
    startsOn: isoDate,
    endsOn: isoDate,
    state: z.enum(["draft", "published"]),
    publishedAt: isoDateTime.nullable(),
    /** A shift was added, cancelled or changed hands since the last publication: check and publish again. */
    changedSincePublished: z.boolean(),
    shifts: z.array(ShiftItem),
    publications: z.array(
      z.object({
        id: uuid,
        publishedAt: isoDateTime,
        publishedBy: uuid,
        noticeMinutes: z.number().int().nullable(),
        shiftCount: z.number().int(),
        openShiftCount: z.number().int(),
      }),
    ),
  })
  .meta({ id: "RotaItem" });

export const RotaSummary = RotaItem.omit({ shifts: true, publications: true }).meta({
  id: "RotaSummary",
});
export const RotaList = z.object({ items: z.array(RotaSummary) }).meta({ id: "RotaList" });

export const ApplyPattern = z
  .object({ patternId: uuid, version })
  .meta({ id: "ApplyPattern", description: "`version` is the rota's" });

export const AddShift = z
  .union([
    z.object({ date: isoDate, templateId: uuid, label: name.optional() }),
    z.object({ date: isoDate, label: name, ...ShiftShapeFields }),
  ])
  .meta({ id: "AddShift" });

export const CancelShift = z.object({ version, reason }).meta({ id: "CancelShift" });

export const RosterBlockerItem = z
  .object({
    /**
     * `dbs:<reason>`, `dbs_supervised_only`, `right_to_work:<reason>`, `registration`,
     * `competence:<name>:<reason>` or `not_active`; an override names the keys it was shown.
     */
    key: z.string(),
    kind: z.enum([
      "dbs",
      "dbs_supervised_only",
      "right_to_work",
      "registration",
      "competence",
      "not_active",
    ]),
    competence: z.string().nullable(),
    /** In words; never what a DBS certificate disclosed. */
    message: z.string(),
  })
  .meta({ id: "RosterBlockerItem" });

export const EligibilityItem = z
  .object({
    workerId: uuid,
    shiftId: uuid,
    date: isoDate,
    allowed: z.boolean(),
    blockers: z.array(RosterBlockerItem),
    /** False when a right to work blocks: illegal working is never overridden (HZ-124). */
    overridable: z.boolean(),
  })
  .meta({ id: "EligibilityItem" });

export const AssignShift = z
  .object({
    workerId: uuid,
    /** The shift's version, so a changed shift is not assigned blind. */
    version,
    /** A manager's override of the rostering rule (scheduling.rota.approve), with why. */
    override: z
      .object({
        justification: z.string().trim().min(10).max(1000),
        /** The blocker keys the manager was shown; refused (409) if they have changed since. */
        blockerKeys: z.array(z.string().max(80)).min(1).max(20),
      })
      .optional(),
  })
  .meta({ id: "AssignShift" });

export const WorkingTimeFindingItem = z
  .object({
    rule: z.string(),
    citation: z.string(),
    outcome: z.enum(["breach", "conditional"]),
    conditions: z.array(z.string()),
    from: isoDateTime,
    to: isoDateTime,
    limitMinutes: z.number(),
    actualMinutes: z.number(),
    compensatoryRestMinutes: z.number(),
    shiftIds: z.array(uuid),
  })
  .meta({ id: "WorkingTimeFindingItem" });

export const WorkerWorkingTime = z
  .object({
    workerId: uuid,
    /** `cannot_check` when the staff file lacks the date of birth or start date. */
    status: z.enum(["checked", "cannot_check"]),
    findings: z.array(WorkingTimeFindingItem),
    notes: z.array(z.string()),
  })
  .meta({ id: "WorkerWorkingTime" });

export const AssignmentResult = z
  .object({
    shift: ShiftItem,
    eligibility: EligibilityItem,
    /** Advice only: the worker's working time with this shift on the rota. */
    workingTime: WorkerWorkingTime,
  })
  .meta({ id: "AssignmentResult" });

export const RemoveAssignment = z.object({ version, reason }).meta({ id: "RemoveAssignment" });

export const StaffingComparisonItem = z
  .object({
    date: isoDate,
    periodKey: z.string().nullable(),
    periodLabel: z.string().nullable(),
    start: isoDateTime.nullable(),
    end: isoDateTime.nullable(),
    status: z.enum(["below", "incomplete", "met_with_warnings", "met", "no_scale"]),
    /** Always shown with the status: never colour alone. */
    word: z.string(),
    requiredMinutes: z.number().nullable(),
    figure: z.enum(["exact", "at_least", "none"]).nullable(),
    providedMinutes: z.number(),
    shortMinutes: z.number().nullable(),
    skills: z.array(
      z.object({
        skill: StaffingSkill,
        label: z.string(),
        minimumStaff: z.number().int(),
        rostered: z.number().int(),
        short: z.number().int(),
      }),
    ),
    openShiftIds: z.array(uuid),
    source: z
      .object({
        scaleId: uuid,
        scaleName: z.string(),
        versionNumber: z.number().int(),
        approvedAt: isoDateTime.nullable(),
      })
      .nullable(),
    notice: z.string(),
    warnings: z.array(z.string()),
    method: z.array(z.string()),
  })
  .meta({ id: "StaffingComparisonItem" });

export const RotaCheck = z
  .object({
    rotaId: uuid,
    rotaVersion: version,
    /** Send back with publish: a changed check is shown again before publishing (HZ-123). */
    digest: z.string(),
    staffing: z.array(StaffingComparisonItem),
    workingTime: z.array(WorkerWorkingTime),
    eligibility: z.array(
      EligibilityItem.extend({
        assignmentId: uuid,
        /** True when a manager's override covers every blocker that stands now. */
        covered: z.boolean(),
      }),
    ),
    openShiftIds: z.array(uuid),
    /** HZ-123: assignments whose member is away on the shift: counted as open, with a warning. */
    coverNeededAssignmentIds: z.array(uuid),
    /** True when any comparison is not `met` or any working time finding stands. */
    hasWarnings: z.boolean(),
    /**
     * Periods whose comparison is `below`, `incomplete` or `no_scale`, as `date:periodKey` (or `date`
     * with no period): each must be acknowledged by name when publishing.
     */
    periodsToAcknowledge: z.array(z.string()),
    /** Assignments the rostering rule blocks with no override covering them: publishing is refused. */
    blockedAssignmentIds: z.array(uuid),
    firstShiftStart: isoDateTime.nullable(),
    noticeMinutes: z.number().int().nullable(),
    asAt: isoDateTime,
  })
  .meta({ id: "RotaCheck" });

export const PublishRota = z
  .object({
    version,
    digest: z.string().min(1).max(128),
    /** Required when the check has warnings: the publisher has read them (HZ-123). */
    acknowledgeWarnings: z.boolean().default(false),
    /** Every entry of the check's `periodsToAcknowledge`, by name. */
    acknowledgedPeriods: z.array(z.string().max(60)).max(500).default([]),
  })
  .meta({ id: "PublishRota" });

export const MyShiftList = z
  .object({
    items: z.array(
      z.object({
        shiftId: uuid,
        locationId: uuid,
        label: z.string(),
        kind: ShiftKind,
        startsAt: isoDateTime,
        endsAt: isoDateTime,
        breakMinutes: z.number().int(),
        changedAfterPublishAt: isoDateTime.nullable(),
      }),
    ),
  })
  .meta({ id: "MyShiftList" });

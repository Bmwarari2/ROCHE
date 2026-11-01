import { z } from "zod";

/**
 * The audit programme and mock inspections (quality.md section 20; QUAL-004; migration 0081).
 * Templates mapped to the compliance framework, schedules per location, audits scored against the
 * questions and framework version they started with, a self-rating given by a person, and actions
 * for what fell short. Dates are yyyy-mm-dd UK dates, times ISO 8601 with offset.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const statementId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const version = z.number().int().min(1);

export const AUDIT_KIND_VALUES = [
  "medication",
  "care_plans",
  "ipc",
  "environment",
  "dignity",
  "night_visit",
  "mock_inspection",
  "other",
] as const;
export const AuditKind = z.enum(AUDIT_KIND_VALUES);
export const AuditAnswerValue = z.enum(["yes", "partial", "no", "not_applicable"]);

export const AuditQuestion = z
  .object({
    key: z.string().regex(/^[a-z0-9_]{1,64}$/),
    text: z.string().trim().min(3).max(500),
    /** How much the question counts in the score. */
    weight: z.number().int().min(1).max(100),
    statementIds: z.array(statementId).max(20),
    /** A "no" or "partial" needs an action with an owner and a due date. */
    actionRequired: z.boolean(),
    /** IPC templates: the Code of Practice criteria the question evidences (`criterion_1` to 10). */
    ipcCriteria: z
      .array(z.string().regex(/^criterion_(?:[1-9]|10)$/))
      .max(10)
      .optional(),
  })
  .meta({ id: "AuditQuestion" });
export type AuditQuestion = z.infer<typeof AuditQuestion>;

export const AuditStarter = z
  .object({
    key: z.string(),
    kind: AuditKind,
    title: z.string(),
    frameworkVersionId: uuid,
    questions: z.array(AuditQuestion),
    source: z.string(),
  })
  .meta({ id: "AuditStarter" });

export const AuditStarterList = z
  .object({ items: z.array(AuditStarter) })
  .meta({ id: "AuditStarterList" });

export const AuditTemplateItem = z
  .object({
    id: uuid,
    key: z.string(),
    kind: AuditKind,
    title: z.string(),
    frameworkVersionId: uuid,
    questions: z.array(AuditQuestion),
    starterKey: z.string().nullable(),
    state: z.enum(["active", "retired"]),
    updatedAt: isoDateTime,
    version,
  })
  .meta({ id: "AuditTemplateItem" });
export type AuditTemplateItem = z.infer<typeof AuditTemplateItem>;

export const AuditTemplateList = z
  .object({ items: z.array(AuditTemplateItem) })
  .meta({ id: "AuditTemplateList" });

const templateKey = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const templateTitle = z.string().trim().min(3).max(200);

export const CreateAuditTemplate = z
  .object({
    key: templateKey,
    /** Copy a Harbour starter template; the fields below then default to the starter's. */
    starterKey: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .optional(),
    kind: AuditKind.optional(),
    title: templateTitle.optional(),
    frameworkVersionId: uuid.optional(),
    questions: z.array(AuditQuestion).min(1).max(200).optional(),
  })
  .meta({ id: "CreateAuditTemplate" });

export const UpdateAuditTemplate = z
  .object({
    version,
    title: templateTitle,
    frameworkVersionId: uuid,
    questions: z.array(AuditQuestion).min(1).max(200),
  })
  .meta({ id: "UpdateAuditTemplate" });

export const RetireAuditTemplate = z.object({ version }).meta({ id: "RetireAuditTemplate" });

export const AuditScheduleItem = z
  .object({
    id: uuid,
    templateId: uuid,
    templateTitle: z.string(),
    kind: AuditKind,
    locationId: uuid,
    frequencyMonths: z.number().int(),
    firstDueOn: isoDate,
    /** The last completed audit of this template at this location, if any. */
    lastCompletedOn: isoDate.nullable(),
    nextDueOn: isoDate,
    /** From the day after the due date (UK). */
    overdue: z.boolean(),
    version,
  })
  .meta({ id: "AuditScheduleItem" });

export const AuditScheduleList = z
  .object({ items: z.array(AuditScheduleItem) })
  .meta({ id: "AuditScheduleList" });

export const CreateAuditSchedule = z
  .object({
    templateId: uuid,
    locationId: uuid,
    frequencyMonths: z.number().int().min(1).max(60),
    firstDueOn: isoDate,
  })
  .meta({ id: "CreateAuditSchedule" });

export const StartAudit = z
  .object({ templateId: uuid, locationId: uuid, auditedOn: isoDate })
  .meta({ id: "StartAudit" });

export const SaveAuditAnswers = z
  .object({
    version,
    answers: z.record(z.string().regex(/^[a-z0-9_]{1,64}$/), AuditAnswerValue.nullable()),
  })
  .meta({ id: "SaveAuditAnswers" });

export const CompleteAudit = z
  .object({
    version,
    /** On the CQC rating scale in the rate table; given by a person, never worked out. */
    selfRating: z.number().int(),
    actions: z
      .array(
        z.object({
          questionKey: z.string().regex(/^[a-z0-9_]{1,64}$/),
          description: z.string().trim().min(3).max(1000),
          ownerId: uuid,
          /** Defaults to the organisation's `quality.audit.action_due_days` after the audit. */
          dueOn: isoDate.optional(),
        }),
      )
      .max(200),
  })
  .meta({ id: "CompleteAudit" });

export const AuditActionItem = z
  .object({
    id: uuid,
    questionKey: z.string(),
    description: z.string(),
    ownerId: uuid,
    dueOn: isoDate,
    taskId: uuid.nullable(),
  })
  .meta({ id: "AuditActionItem" });

export const AuditRecordSummary = z
  .object({
    id: uuid,
    templateId: uuid,
    kind: AuditKind,
    title: z.string(),
    frameworkVersionId: uuid,
    locationId: uuid,
    auditedOn: isoDate,
    state: z.enum(["in_progress", "completed"]),
    scorePercent: z.number().nullable(),
    selfRating: z.number().int().nullable(),
    version,
  })
  .meta({ id: "AuditRecordSummary" });

export const AuditRecordList = z
  .object({ items: z.array(AuditRecordSummary) })
  .meta({ id: "AuditRecordList" });

export const AuditRecordDetail = AuditRecordSummary.extend({
  templateVersion: z.number().int(),
  /** Whether the framework version it was scored against is the one in force today. */
  frameworkInForce: z.boolean(),
  questions: z.array(AuditQuestion),
  answers: z.record(z.string(), AuditAnswerValue.nullable()),
  score: z.object({
    /** 0 to 100, exact; null when nothing could be scored. */
    percent: z.number().nullable(),
    achieved: z.number(),
    possible: z.number(),
    complete: z.boolean(),
    unanswered: z.array(z.string()),
    /** The method in words, shown beside the score. */
    method: z.string(),
  }),
  /** The CQC words for the self-rating ("Good"), with the number. */
  selfRatingWords: z.string().nullable(),
  /** The answers that fell short, by the quality statements their questions evidence. */
  findings: z.array(z.object({ statementId: z.string(), questionKeys: z.array(z.string()) })),
  actions: z.array(AuditActionItem),
  startedBy: uuid,
  completedBy: uuid.nullable(),
  completedAt: isoDateTime.nullable(),
}).meta({ id: "AuditRecordDetail" });
export type AuditRecordDetail = z.infer<typeof AuditRecordDetail>;

export type AuditStarter = z.infer<typeof AuditStarter>;
export type AuditScheduleItem = z.infer<typeof AuditScheduleItem>;
export type AuditRecordSummary = z.infer<typeof AuditRecordSummary>;
export type AuditActionItem = z.infer<typeof AuditActionItem>;
export type AuditAnswerValue = z.infer<typeof AuditAnswerValue>;
export type AuditKind = z.infer<typeof AuditKind>;

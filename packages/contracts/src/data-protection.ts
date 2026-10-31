import { z } from "zod";

/**
 * The breach register, Thapsus's processor breach notices and data protection complaints
 * (PLAT-022; platform.md rules 6 to 10 and 18 to 26). Clocks are worked out by the API from the
 * stored dates and the rate table each time they are read; the breach assessment is decision
 * support only and never decides.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const BreachFactors = z
  .object({
    peopleAffected: z.number().int().min(0).max(10_000_000),
    identifiable: z.boolean(),
    specialCategory: z.boolean(),
    safeguardingOrLocationAtRisk: z.boolean(),
    disclosedOutsideOrganisation: z.boolean(),
    careRecordsUnavailable: z.boolean(),
    contained: z.boolean(),
  })
  .meta({ id: "BreachFactors" });

export const BreachSeverity = z
  .enum(["low", "medium", "high", "critical"])
  .meta({ id: "BreachSeverity" });

export const BreachSuggestion = z
  .object({
    severity: BreachSeverity,
    /** Codes the screen says in words (`BreachReason`). */
    reasons: z.array(z.string()),
    considerReportingToIco: z.boolean(),
    considerTellingIndividuals: z.boolean(),
  })
  .meta({
    id: "BreachSuggestion",
    description: "Decision support only: the decision is a person's, with reasons.",
  });

export const BreachClockOut = z
  .object({
    deadline: isoDateTime,
    state: z.enum(["open", "overdue", "reported_on_time", "reported_late"]),
    hoursLeft: z.number().int().nullable(),
    delayReasonRequired: z.boolean(),
  })
  .meta({ id: "BreachClock" });

export const ProcessorBreachNoticeOut = z
  .object({
    id: uuid,
    followsId: uuid.nullable(),
    sentAt: isoDateTime,
    nature: z.string(),
    dataCategories: z.string(),
    approxPeople: z.number().int().nullable(),
    approxRecords: z.number().int().nullable(),
    likelyConsequences: z.string(),
    measures: z.string(),
    tenantActions: z.string(),
    contact: z.string(),
    acknowledgedAt: isoDateTime.nullable(),
    acknowledgedBy: uuid.nullable(),
  })
  .meta({ id: "ProcessorBreachNotice" });

export const BreachOut = z
  .object({
    id: uuid,
    locationId: uuid.nullable(),
    source: z.enum(["tenant", "processor_notice"]),
    summary: z.string(),
    awareAt: isoDateTime,
    occurredAt: isoDateTime.nullable(),
    factors: BreachFactors.nullable(),
    suggestion: BreachSuggestion.nullable(),
    decision: z
      .object({
        reportToIco: z.boolean(),
        tellIndividuals: z.boolean(),
        reasoning: z.string(),
        acknowledgedSuggestion: z.boolean(),
        decidedBy: uuid,
        decidedAt: isoDateTime,
      })
      .nullable(),
    report: z
      .object({
        reportedAt: isoDateTime,
        icoReference: z.string(),
        delayReason: z.string().nullable(),
      })
      .nullable(),
    individuals: z.object({ notice: z.string(), toldOn: ukDate }).nullable(),
    status: z.enum(["open", "closed"]),
    lessons: z.string().nullable(),
    closedAt: isoDateTime.nullable(),
    clock: BreachClockOut,
    notices: z.array(ProcessorBreachNoticeOut),
    createdAt: isoDateTime,
    version: z.number().int(),
  })
  .meta({ id: "Breach" });
export type BreachOut = z.infer<typeof BreachOut>;

export const BreachList = z
  .object({
    items: z.array(BreachOut),
    reportHours: z.number(),
    /** More entries exist than the list returns: never read as the whole register. */
    truncated: z.boolean(),
  })
  .meta({ id: "BreachList" });

const Versioned = { expectedVersion: z.number().int().min(1) };

export const RecordBreach = z
  .object({
    locationId: uuid.nullable().optional(),
    summary: text(10, 4000),
    awareAt: isoDateTime,
    occurredAt: isoDateTime.nullable().optional(),
  })
  .meta({ id: "RecordBreach" });

export const ChangeBreachFacts = z
  .object({
    ...Versioned,
    locationId: uuid.nullable().optional(),
    summary: text(10, 4000).optional(),
    awareAt: isoDateTime.optional(),
    occurredAt: isoDateTime.nullable().optional(),
  })
  .meta({ id: "ChangeBreachFacts" });

export const AssessBreach = z
  .object({ ...Versioned, factors: BreachFactors })
  .meta({ id: "AssessBreach" });

export const DecideBreach = z
  .object({
    ...Versioned,
    reportToIco: z.boolean(),
    tellIndividuals: z.boolean(),
    reasoning: z.string().trim().max(4000),
    acknowledgedSuggestion: z.boolean().default(false),
  })
  .meta({ id: "DecideBreach" });

export const ReportBreach = z
  .object({
    ...Versioned,
    reportedAt: isoDateTime,
    icoReference: text(1, 100),
    delayReason: text(1, 4000).nullable().optional(),
  })
  .meta({ id: "ReportBreach" });

export const SubjectNoticeDraft = z.object({ notice: z.string() }).meta({
  id: "SubjectNoticeDraft",
  description:
    "Harbour's plain-English template filled from the register entry; the parts in square brackets are for a person to write before it is sent.",
});

export const TellIndividuals = z
  .object({ ...Versioned, notice: text(20, 10000), toldOn: ukDate })
  .meta({ id: "TellIndividuals" });

export const CloseBreach = z
  .object({ ...Versioned, lessons: text(20, 4000) })
  .meta({ id: "CloseBreach" });

export const SendProcessorBreachNotice = z
  .object({
    tenantId: uuid,
    /** The first notice this one follows up, when facts emerged later. */
    followsId: uuid.nullable().optional(),
    nature: text(10, 4000),
    dataCategories: text(3, 2000),
    approxPeople: z.number().int().min(0).max(100_000_000).nullable().optional(),
    approxRecords: z.number().int().min(0).max(1_000_000_000).nullable().optional(),
    likelyConsequences: text(3, 4000),
    measures: text(3, 4000),
    tenantActions: text(3, 4000),
    contact: text(3, 500),
  })
  .meta({ id: "SendProcessorBreachNotice" });

export const ProcessorBreachNoticeSent = z
  .object({ noticeId: uuid, breachId: uuid })
  .meta({ id: "ProcessorBreachNoticeSent" });

export const ComplaintClockOut = z
  .object({
    acknowledgeDueOn: ukDate.nullable(),
    acknowledgeTargetOn: ukDate,
    acknowledgement: z.enum(["not_applicable", "due", "overdue", "done", "done_late"]),
    nextUpdateDueOn: ukDate.nullable(),
    update: z.enum(["due", "overdue", "closed"]),
  })
  .meta({ id: "DataProtectionComplaintClock" });

const Channel = z.enum([
  "form",
  "email",
  "letter",
  "phone",
  "in_person",
  "forwarded_by_thapsus",
  "other",
]);
const ComplainantKind = z.enum(["person_supported", "representative", "family", "staff", "other"]);
const About = z.enum(["access", "accuracy", "sharing", "security", "retention", "other"]);

export const ComplaintOut = z
  .object({
    id: uuid,
    locationId: uuid.nullable(),
    receivedOn: ukDate,
    channel: Channel,
    complainantKind: ComplainantKind,
    complainantName: z.string(),
    complainantContact: z.string().nullable(),
    personId: uuid.nullable(),
    about: About,
    summary: z.string(),
    acknowledgedOn: ukDate.nullable(),
    lastContactOn: ukDate.nullable(),
    outcome: z.string().nullable(),
    icoRightStated: z.boolean(),
    breachId: uuid.nullable(),
    status: z.enum(["open", "closed"]),
    closedOn: ukDate.nullable(),
    clock: ComplaintClockOut,
    version: z.number().int(),
  })
  .meta({ id: "DataProtectionComplaint" });

export const DataProtectionComplaintList = z
  .object({ items: z.array(ComplaintOut), truncated: z.boolean() })
  .meta({ id: "DataProtectionComplaintList" });

export const RecordComplaint = z
  .object({
    locationId: uuid.nullable().optional(),
    receivedOn: ukDate,
    channel: Channel,
    complainantKind: ComplainantKind,
    complainantName: text(1, 200),
    complainantContact: text(1, 500).nullable().optional(),
    personId: uuid.nullable().optional(),
    about: About,
    summary: text(10, 4000),
    breachId: uuid.nullable().optional(),
  })
  .meta({ id: "RecordDataProtectionComplaint" });

export const ComplaintDate = z
  .object({ ...Versioned, on: ukDate })
  .meta({ id: "DataProtectionComplaintDate" });

export const CloseComplaint = z
  .object({
    ...Versioned,
    closedOn: ukDate,
    outcome: z.string().trim().max(10000),
    icoRightStated: z.boolean(),
  })
  .meta({ id: "CloseDataProtectionComplaint" });

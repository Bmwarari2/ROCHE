import { z } from "zod";
import { StatutoryNotificationSummary } from "./safety";

/**
 * Outbreak management and IPC audits (safety.md section 11; SAFE-013; HZ-013; migration 0093).
 * Outbreaks at a location with their case line list, the UKHSA report fields worked out from it,
 * and closure; IPC audits read against the Code of Practice criteria. Dates are yyyy-mm-dd UK
 * dates, times ISO 8601 with offset. People and staff appear as ids only.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);

export const OutbreakSyndrome = z.enum([
  "acute_respiratory",
  "flu",
  "covid_19",
  "diarrhoea_vomiting",
  "other",
]);
export const OutbreakSymptom = z.enum([
  "fever",
  "cough",
  "sore_throat",
  "shortness_of_breath",
  "loss_of_taste_or_smell",
  "diarrhoea",
  "vomiting",
  "new_confusion",
  "other",
]);
export const OutbreakTestType = z.enum(["lateral_flow", "pcr", "stool_sample", "other"]);
export const OutbreakTestResult = z.enum(["not_tested", "pending", "positive", "negative"]);
export const VaccinationAnswer = z.enum(["yes", "no", "unknown"]);
export const OutbreakCaseOutcome = z.enum(["unwell", "recovered", "hospitalised", "died"]);

export const IpcCriterionItem = z
  .object({ id: z.string(), number: z.number().int(), title: z.string(), source: z.string() })
  .meta({ id: "IpcCriterionItem" });

export const IpcCriterionList = z
  .object({ items: z.array(IpcCriterionItem) })
  .meta({ id: "IpcCriterionList" });

export const IpcAuditCriteria = z
  .object({
    auditId: uuid,
    criteria: z.array(
      z.object({
        id: z.string(),
        number: z.number().int(),
        title: z.string(),
        questionKeys: z.array(z.string()),
        /** The audit's own weighted score over the criterion's questions; null when none covers it. */
        percent: z.number().nullable(),
        achieved: z.number(),
        possible: z.number(),
        fellShort: z.array(z.string()),
      }),
    ),
    /** The method in words, shown beside the scores. */
    method: z.string(),
  })
  .meta({ id: "IpcAuditCriteria" });

const organism = z.string().trim().min(2).max(200);
const hptReference = z.string().trim().min(1).max(100);

export const DeclareOutbreak = z
  .object({
    locationId: uuid,
    syndrome: OutbreakSyndrome,
    organism: organism.optional(),
    hptReference: hptReference.optional(),
  })
  .meta({ id: "DeclareOutbreak" });

export const UpdateOutbreak = z
  .object({ version, organism: organism.nullable(), hptReference: hptReference.nullable() })
  .meta({ id: "UpdateOutbreak" });

export const CloseOutbreak = z
  .object({ version, closedOn: isoDate, reason: z.string().trim().min(3).max(1000) })
  .meta({ id: "CloseOutbreak" });

export const RecordOutbreakCase = z
  .object({
    caseType: z.enum(["resident", "staff"]),
    personId: uuid.nullable(),
    tenantUserId: uuid.nullable(),
    onsetOn: isoDate,
    symptoms: z.array(OutbreakSymptom).min(1).max(9),
    testType: OutbreakTestType.nullable(),
    testedOn: isoDate.nullable(),
    testResult: OutbreakTestResult,
    fluVaccinated: VaccinationAnswer,
    covidVaccinated: VaccinationAnswer,
    outcome: OutbreakCaseOutcome,
    outcomeOn: isoDate.nullable(),
    /** The person's last row on this outbreak, when this updates or corrects it. */
    supersedesId: uuid.nullable(),
    correctionReason: z.string().trim().min(3).max(500).nullable(),
  })
  .meta({ id: "RecordOutbreakCase" });

export const OutbreakCaseItem = RecordOutbreakCase.extend({
  id: uuid,
  /** False once a later row supersedes it. */
  current: z.boolean(),
  createdAt: isoDateTime,
  createdBy: uuid.nullable(),
}).meta({ id: "OutbreakCaseItem" });

export const OutbreakSummary = z
  .object({
    id: uuid,
    locationId: uuid,
    syndrome: OutbreakSyndrome,
    organism: z.string().nullable(),
    state: z.enum(["declared", "closed"]),
    declaredAt: isoDateTime,
    declaredBy: uuid,
    notificationId: uuid.nullable(),
    hptReference: z.string().nullable(),
    closedOn: isoDate.nullable(),
    closedAt: isoDateTime.nullable(),
    closedBy: uuid.nullable(),
    closureReason: z.string().nullable(),
    version,
  })
  .meta({ id: "OutbreakSummary" });

export const OutbreakList = z
  .object({ items: z.array(OutbreakSummary) })
  .meta({ id: "OutbreakList" });

const tally = z.object({ yes: z.number().int(), no: z.number().int(), unknown: z.number().int() });

export const UkhsaReportFieldsView = z
  .object({
    settingName: z.string(),
    postcode: z.string().nullable(),
    cqcLocationId: z.string().nullable(),
    syndrome: OutbreakSyndrome,
    organism: z.string().nullable(),
    declaredOn: isoDate,
    residentCases: z.number().int(),
    staffCases: z.number().int(),
    firstOnsetOn: isoDate.nullable(),
    latestOnsetOn: isoDate.nullable(),
    tested: z.number().int(),
    positive: z.number().int(),
    pending: z.number().int(),
    hospitalised: z.number().int(),
    died: z.number().int(),
    fluVaccination: tally,
    covidVaccination: tally,
    /** What the report still needs, in words; never guessed. */
    missing: z.array(z.string()),
    source: z.object({ source: z.string(), provision: z.string(), url: z.string() }),
  })
  .meta({ id: "UkhsaReportFields" });

export const OutbreakDetail = OutbreakSummary.extend({
  /** Every row you may see, oldest first, each marked current or superseded. */
  cases: z.array(OutbreakCaseItem),
  report: UkhsaReportFieldsView,
  /** The outbreak's own UKHSA report and its clock (HZ-013); null if it cannot be seen. */
  notification: StatutoryNotificationSummary.nullable(),
  /** Cases still unwell, said beside a closure. */
  stillUnwell: z.number().int(),
  /** Line-list rows about residents you cannot see: counted in the report, not listed here. */
  rowsNotShown: z.number().int(),
}).meta({ id: "OutbreakDetail" });
export type OutbreakDetail = z.infer<typeof OutbreakDetail>;

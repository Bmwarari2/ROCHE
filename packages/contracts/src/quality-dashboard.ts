import { z } from "zod";

/**
 * The quality dashboard and PIR prefill (QUAL-005, QUAL-006; quality.md section 22). Every figure
 * carries its working: numerator, denominator, period, source and method. A figure Harbour cannot
 * stand behind (a source not built, incomplete data, a small number) is `no_data` with its reason,
 * never rated, and a withheld count is null, never 0.
 */

const uuid = z.uuid();
const ukDate = z.iso.date();

export const QualityIndicatorKey = z
  .enum([
    "falls",
    "pressure_ulcers",
    "medication_errors",
    "missed_visits",
    "overdue_reviews",
    "training_compliance",
    "agency_hours",
    "complaints",
    "staff_turnover",
    "incident_response",
  ])
  .meta({ id: "QualityIndicatorKey" });

export const QualityIndicatorStatus = z
  .enum(["green", "amber", "red", "no_data"])
  .meta({ id: "QualityIndicatorStatus" });

export const QualityNoDataReason = z
  .enum([
    "unknown_indicator",
    "no_value",
    "no_denominator",
    "incomplete_data",
    "no_target",
    "source_not_built",
    "small_number",
  ])
  .meta({ id: "QualityNoDataReason" });

const Period = z.object({ from: ukDate, to: ukDate });

export const QualityIndicatorOut = z
  .object({
    key: QualityIndicatorKey,
    title: z.string(),
    unit: z.string(),
    direction: z.enum(["lower_is_better", "higher_is_better"]),
    method: z.string(),
    /** The source in words; null when Harbour does not record it yet. */
    source: z.string().nullable(),
    numerator: z.number().nullable(),
    denominator: z.number().nullable(),
    period: Period,
    value: z.number().nullable(),
    display: z.number().nullable(),
    status: QualityIndicatorStatus,
    reasonCode: QualityNoDataReason.nullable(),
    reason: z.string().nullable(),
    /** The target that rated it, and whether it is the location's own or the organisation's. */
    target: z
      .object({
        green: z.number(),
        amber: z.number(),
        level: z.enum(["location", "organisation"]),
        /** The organisation default, beside a location's own target. */
        organisationDefault: z.object({ green: z.number(), amber: z.number() }).nullable(),
      })
      .nullable(),
  })
  .meta({ id: "QualityIndicatorOut" });

export const QualityDashboardQuery = z.object({
  locationId: uuid,
  from: ukDate,
  to: ukDate,
});

export const QualityDashboard = z
  .object({
    locationId: uuid,
    /** When the figures were counted: records synced later are in a later view. */
    generatedAt: z.iso.datetime({ offset: true }),
    period: Period,
    minGroupSize: z.number().int(),
    indicators: z.array(QualityIndicatorOut),
  })
  .meta({ id: "QualityDashboard" });

export const QualityIndicatorTargetOut = z
  .object({
    id: uuid,
    locationId: uuid.nullable(),
    indicatorKey: QualityIndicatorKey,
    green: z.number(),
    amber: z.number(),
    version: z.number().int(),
  })
  .meta({ id: "QualityIndicatorTargetOut" });

export const QualityIndicatorTargetList = z
  .object({ items: z.array(QualityIndicatorTargetOut) })
  .meta({ id: "QualityIndicatorTargetList" });

const targetValue = z.number().finite().min(0).max(1_000_000);

export const SetQualityIndicatorTarget = z
  .object({
    locationId: uuid.nullable(),
    indicatorKey: QualityIndicatorKey,
    green: targetValue,
    amber: targetValue,
    /** Null to add a target; the target's version to change it. */
    expectedVersion: z.number().int().min(1).nullable(),
  })
  .meta({ id: "SetQualityIndicatorTarget" });

export const ClearQualityIndicatorTarget = z
  .object({ expectedVersion: z.number().int().min(1) })
  .meta({ id: "ClearQualityIndicatorTarget" });

export const PirQuestionArea = z
  .enum(["safe", "effective", "caring", "responsive", "well-led"])
  .meta({ id: "PirQuestionArea" });

export const PirPrefillItem = z
  .object({
    key: z.string(),
    area: PirQuestionArea,
    label: z.string(),
    unit: z.enum(["count", "percent", "hours", "yes_no"]),
    source: z.string(),
    status: z.enum(["prefilled", "to_complete"]),
    value: z.union([z.number(), z.boolean()]).nullable(),
    asOf: ukDate.nullable(),
    records: z.number().int().nullable(),
    reasonCode: z.enum(["not_built", "no_value", "small_number"]).nullable(),
    reason: z.string().nullable(),
  })
  .meta({ id: "PirPrefillItem" });

export const PirPrefill = z
  .object({
    locationId: uuid,
    questionSet: z.object({
      regulator: z.string(),
      name: z.string(),
      version: z.string(),
      confirmed: z.boolean(),
    }),
    period: Period,
    asOf: ukDate,
    items: z.array(PirPrefillItem),
  })
  .meta({ id: "PirPrefill" });

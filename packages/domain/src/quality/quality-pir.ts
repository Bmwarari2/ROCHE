/**
 * Provider Information Return prefill (quality.md section 17, rules 23 and 24; QUAL-006; CQC PIR).
 * The data points Harbour can collate, grouped by CQC key question, each with where it comes from.
 * The draft shows each value with its as-of date and how many records lie behind it, or says it is
 * not available; it never fills a gap with 0 and never submits anything (the Registered Manager
 * reviews the draft and copies it across). The list is to be confirmed against CQC's current PIR
 * questions (H-602). Pure functions.
 */

export const PIR_AREAS = ["safe", "effective", "caring", "responsive", "well-led"] as const;
export type PirArea = (typeof PIR_AREAS)[number];

export interface PirDataPoint {
  readonly key: string;
  readonly area: PirArea;
  readonly label: string;
  readonly unit: "count" | "percent" | "hours" | "yes_no";
  /** The slice whose published events supply the value. */
  readonly source: string;
}

/** Rule 23: the data points (master prompt 11.2), by CQC key question. */
export const PIR_DATA_POINTS: readonly PirDataPoint[] = [
  {
    key: "staff_headcount",
    area: "well-led",
    label: "Staff in post",
    unit: "count",
    source: "workforce (slice 11)",
  },
  {
    key: "vacancies",
    area: "well-led",
    label: "Vacancies",
    unit: "count",
    source: "workforce (slice 11)",
  },
  {
    key: "agency_hours",
    area: "safe",
    label: "Agency hours in the last 4 weeks",
    unit: "hours",
    source: "scheduling (slice 27)",
  },
  {
    key: "training_compliance",
    area: "effective",
    label: "Required training in date",
    unit: "percent",
    source: "workforce (slice 17)",
  },
  {
    key: "supervision_compliance",
    area: "effective",
    label: "Supervisions in date",
    unit: "percent",
    source: "workforce (slice 17)",
  },
  {
    key: "incidents",
    area: "safe",
    label: "Incidents in the last 12 months",
    unit: "count",
    source: "safety (slice 7)",
  },
  {
    key: "medication_errors",
    area: "safe",
    label: "Medication errors in the last 12 months",
    unit: "count",
    source: "medicines (slice 45)",
  },
  {
    key: "complaints",
    area: "responsive",
    label: "Complaints in the last 12 months",
    unit: "count",
    source: "safety (slice 18)",
  },
  {
    key: "compliments",
    area: "caring",
    label: "Compliments in the last 12 months",
    unit: "count",
    source: "safety (slice 18)",
  },
  {
    key: "digital_care_records",
    area: "well-led",
    label: "Care records kept digitally",
    unit: "yes_no",
    source: "platform",
  },
];

export interface PirValue {
  readonly value: number | boolean;
  /** UK date the value describes. */
  readonly asOf: string;
  /** How many records lie behind it, so the manager can check it. */
  readonly records: number;
}

export interface PirDraftItem {
  readonly dataPoint: PirDataPoint;
  readonly value: PirValue | null;
  /** Words shown in place of a value: never 0 for a gap. */
  readonly notAvailable: string | null;
}

/** Rule 24: the draft, every data point in order, each with its value or why there is none. */
export function assemblePirDraft(
  values: Readonly<Record<string, PirValue | null | undefined>>,
): PirDraftItem[] {
  return PIR_AREAS.flatMap((area) =>
    PIR_DATA_POINTS.filter((p) => p.area === area).map((dataPoint) => {
      const value = values[dataPoint.key] ?? null;
      const usable =
        value !== null &&
        (typeof value.value === "boolean"
          ? dataPoint.unit === "yes_no"
          : Number.isFinite(value.value));
      return usable
        ? { dataPoint, value, notAvailable: null }
        : {
            dataPoint,
            value: null,
            notAvailable: "Not available in Harbour: check your own records.",
          };
    }),
  );
}

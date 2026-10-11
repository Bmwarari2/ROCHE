/**
 * Advance care records (master prompt 10.1 end of life; care.md section 2 `advance_care_record`;
 * register row CARE-015; hazard HZ-015): ReSPECT plans, DNACPR decisions, advance decisions to
 * refuse treatment (ADRT) and advance care plans. Harbour shows the record and the decision it
 * carries; the signed form stays with the person as the provider's policy requires.
 *
 * The resuscitation status shown in the point-of-care header comes only from a DNACPR decision or
 * a ReSPECT plan in force (active). A missing record reads "not recorded", never blank. A review
 * date passing does not end a decision: it stays in force and the review shows as overdue. Records
 * in force that disagree are flagged so staff check the documents.
 */

import { isIsoDate } from "./assessment";

export const ADVANCE_CARE_KINDS = ["respect", "dnacpr", "adrt", "advance_care_plan"] as const;
export type AdvanceCareKind = (typeof ADVANCE_CARE_KINDS)[number];

export const ADVANCE_CARE_STATUSES = ["active", "withdrawn", "superseded"] as const;
export type AdvanceCareStatus = (typeof ADVANCE_CARE_STATUSES)[number];

/** Adult wording of ReSPECT section 4 and of a DNACPR decision. */
export const CPR_DECISIONS = ["attempt_cpr", "do_not_attempt_cpr"] as const;
export type CprDecision = (typeof CPR_DECISIONS)[number];

/**
 * SNOMED CT concepts from the NHS "EOL CPR Status Code" value set (HL7 UK, FHIR STU3 assets). The
 * UK edition loaded from TRUD is the authority; these two are the export mapping.
 */
export const CPR_DECISION_SNOMED: Readonly<
  Record<CprDecision, { readonly code: string; readonly display: string }>
> = {
  attempt_cpr: { code: "450475007", display: "For cardiopulmonary resuscitation" },
  do_not_attempt_cpr: { code: "450476008", display: "Not for cardiopulmonary resuscitation" },
};

/** Kinds that carry the CPR decision the header shows. */
const CPR_KINDS: readonly AdvanceCareKind[] = ["respect", "dnacpr"];
/** Kinds completed by a clinician, whose name and role are recorded. */
const CLINICIAN_KINDS: readonly AdvanceCareKind[] = ["respect", "dnacpr"];

export interface AdvanceCareInput {
  readonly kind: AdvanceCareKind;
  readonly cprDecision: CprDecision | null;
  readonly clinicianName: string | null;
  readonly clinicianRole: string | null;
  readonly completedOn: string;
  readonly reviewDueOn: string | null;
  /** Today in UK time. */
  readonly today: string;
}

export type AdvanceCareField =
  | "cprDecision"
  | "clinicianName"
  | "clinicianRole"
  | "completedOn"
  | "reviewDueOn";

export type AdvanceCareCheck =
  | { readonly ok: true; readonly cprDecision: CprDecision | null }
  | {
      readonly ok: false;
      readonly issues: readonly { readonly field: AdvanceCareField; readonly message: string }[];
    };

const filled = (value: string | null | undefined) => (value?.trim().length ?? 0) > 0;

export function checkAdvanceCareRecord(input: AdvanceCareInput): AdvanceCareCheck {
  const issues: { field: AdvanceCareField; message: string }[] = [];
  let cprDecision = input.cprDecision;
  if (input.kind === "dnacpr") {
    if (cprDecision === "attempt_cpr") {
      issues.push({
        field: "cprDecision",
        message: "A DNACPR decision means do not attempt CPR. Record a ReSPECT plan instead.",
      });
    }
    cprDecision = "do_not_attempt_cpr";
  } else if (input.kind === "respect") {
    if (cprDecision === null) {
      issues.push({
        field: "cprDecision",
        message: "Record the CPR recommendation from section 4 of the ReSPECT form.",
      });
    }
  } else if (cprDecision !== null) {
    issues.push({
      field: "cprDecision",
      message: "Record a CPR decision on a ReSPECT or DNACPR record so it shows in the header.",
    });
  }
  if (CLINICIAN_KINDS.includes(input.kind)) {
    if (!filled(input.clinicianName)) {
      issues.push({
        field: "clinicianName",
        message: "Record the clinician who made the decision.",
      });
    }
    if (!filled(input.clinicianRole)) {
      issues.push({ field: "clinicianRole", message: "Record the clinician's role." });
    }
  }
  if (!isIsoDate(input.completedOn) || input.completedOn > input.today) {
    issues.push({
      field: "completedOn",
      message: "The date completed must be a real date, today or earlier.",
    });
  } else if (
    input.reviewDueOn !== null &&
    (!isIsoDate(input.reviewDueOn) || input.reviewDueOn < input.completedOn)
  ) {
    issues.push({
      field: "reviewDueOn",
      message: "The review date must be on or after the date completed.",
    });
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, cprDecision: CPR_KINDS.includes(input.kind) ? cprDecision : null };
}

export type WithdrawalCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export function checkWithdrawal(reason: string | null | undefined): WithdrawalCheck {
  return filled(reason)
    ? { ok: true }
    : { ok: false, message: "Say why the record is withdrawn, and by whom." };
}

export interface AdvanceCareRecordState {
  readonly id: string;
  readonly kind: AdvanceCareKind;
  readonly status: AdvanceCareStatus;
  readonly cprDecision: CprDecision | null;
  readonly completedOn: string;
  readonly clinicianName: string | null;
  readonly clinicianRole: string | null;
  readonly reviewDueOn: string | null;
}

export interface ResuscitationStatus {
  readonly status: "not_recorded" | CprDecision;
  /** Records in force disagree: staff check the documents. */
  readonly conflicting: boolean;
  readonly recordId: string | null;
  readonly kind: "respect" | "dnacpr" | null;
  readonly completedOn: string | null;
  readonly clinicianName: string | null;
  readonly clinicianRole: string | null;
  readonly reviewDueOn: string | null;
  readonly reviewOverdue: boolean;
}

/**
 * The ReSPECT and DNACPR records with a CPR decision in force, newest first: the records the
 * header and every summary read (`resuscitationStatus`, the export's current summary).
 */
export function cprRecordsInForce(
  records: readonly AdvanceCareRecordState[],
): AdvanceCareRecordState[] {
  return records
    .filter((r) => r.status === "active" && CPR_KINDS.includes(r.kind) && r.cprDecision !== null)
    .sort((a, b) =>
      a.completedOn === b.completedOn
        ? b.id.localeCompare(a.id)
        : b.completedOn.localeCompare(a.completedOn),
    );
}

export function resuscitationStatus(
  records: readonly AdvanceCareRecordState[],
  today: string,
): ResuscitationStatus {
  const inForce = cprRecordsInForce(records);
  const current = inForce[0];
  if (!current?.cprDecision) {
    return {
      status: "not_recorded",
      conflicting: false,
      recordId: null,
      kind: null,
      completedOn: null,
      clinicianName: null,
      clinicianRole: null,
      reviewDueOn: null,
      reviewOverdue: false,
    };
  }
  return {
    status: current.cprDecision,
    conflicting: inForce.some((r) => r.cprDecision !== current.cprDecision),
    recordId: current.id,
    kind: current.kind as "respect" | "dnacpr",
    completedOn: current.completedOn,
    clinicianName: current.clinicianName,
    clinicianRole: current.clinicianRole,
    reviewDueOn: current.reviewDueOn,
    reviewOverdue: current.reviewDueOn !== null && today > current.reviewDueOn,
  };
}

/**
 * A correction made on the phone (Phase 2 slice 70; medicines.md 13.4; HZ-004): a record that has
 * reached Harbour is never changed (the MAR row locks once synced); a correction is a new record
 * that names the one it corrects (`supersedes_id`), with why in at least 20 characters, sent to
 * `POST /v1/medicine-administrations/{id}/corrections`, where every rule is checked again. The
 * round reads the correction in place of the record at once, and the record stays, struck through
 * on the MAR. A correction of a controlled drug's record moves the register, so it is made on the
 * web with step-up and a witness. Pure.
 */
import { type AdministrationOutcome, OUTCOME_REASONS } from "@harbour/domain";

/** The domain's minimum for a correction's reason (`checkCorrection`). */
export const CORRECTION_REASON_MIN = 20;

export type CorrectionProblem =
  | "not_synced"
  | "controlled_drug_on_web"
  | "reason_required"
  | "note_required"
  | "amount_required"
  | "correction_reason_short"
  | "nothing_changed";

export interface CorrectionInput {
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly memberId: string;
  /** The record corrected, as the phone holds it. */
  readonly original: {
    readonly id: string;
    readonly entryId: string;
    readonly dueAt: string | null;
    readonly givenAt: string;
    readonly outcome: string;
    readonly quantity: string | null;
    readonly unitCode: string | null;
    /** Still waiting on this phone: it is corrected by recording it again once sent. */
    readonly synced: boolean;
  };
  readonly outcome: AdministrationOutcome;
  readonly reason: { readonly code: string; readonly note: string | null } | null;
  readonly amount: { readonly quantity: number; readonly unitCode: string } | null;
  readonly correctionReason: string;
  readonly controlledDrug: boolean;
  readonly at: Date;
}

export function correctionProblems(input: CorrectionInput): CorrectionProblem[] {
  const problems: CorrectionProblem[] = [];
  if (!input.original.synced) problems.push("not_synced");
  if (input.controlledDrug) problems.push("controlled_drug_on_web");
  const codes = OUTCOME_REASONS[input.outcome];
  if (codes.length > 0 && (!input.reason || !codes.includes(input.reason.code))) {
    problems.push("reason_required");
  }
  if (
    (input.reason?.code === "other" || input.outcome === "withheld") &&
    !input.reason?.note?.trim()
  ) {
    problems.push("note_required");
  }
  if (input.outcome === "given" && !input.amount) problems.push("amount_required");
  if (input.correctionReason.trim().length < CORRECTION_REASON_MIN) {
    problems.push("correction_reason_short");
  }
  const sameAmount =
    (input.amount === null && input.original.quantity === null) ||
    (input.amount !== null && Number(input.original.quantity) === input.amount.quantity);
  if (input.outcome === input.original.outcome && sameAmount && !input.reason) {
    problems.push("nothing_changed");
  }
  return problems;
}

/** The row the phone writes: the correction, naming the record, waiting to be sent. */
export function localCorrectionRow(input: CorrectionInput): Record<string, string | null> {
  const body = {
    id: input.id,
    entryId: input.original.entryId,
    dueAt: input.original.dueAt,
    outcome: input.outcome,
    reason: input.reason
      ? { code: input.reason.code, note: input.reason.note?.trim() || null }
      : null,
    amount: input.amount,
    correctionReason: input.correctionReason.trim(),
    // The time the dose was given or the outcome happened stays the record's own.
    givenAt: input.original.givenAt,
  };
  return {
    id: input.id,
    tenant_id: input.tenantId,
    person_id: input.personId,
    medication_id: input.original.entryId,
    due_at: input.original.dueAt,
    outcome: input.outcome,
    reason_code: input.reason?.code ?? null,
    quantity: input.amount ? String(input.amount.quantity) : null,
    unit_code: input.amount?.unitCode ?? null,
    given_at: input.original.givenAt,
    administered_by: input.memberId,
    recorded_by: input.memberId,
    recorded_at: input.at.toISOString(),
    supersedes_id: input.original.id,
    request: JSON.stringify({
      kind: "correction",
      personId: input.personId,
      supersedesId: input.original.id,
      body,
    }),
  };
}

/** Who may correct records anyone made, as the API decides (`medicines.record.manage`). */
export const CORRECT_ANYONE = "medicines.record.manage";

/**
 * Whether the member may correct this record on the phone: their own, or anyone's with
 * `medicines.record.manage`, as the API checks on upload (guides review of the phone, HZ-004). A
 * record whose recorder the phone does not know is treated as someone else's.
 */
export function mayCorrectOnPhone(
  record: { readonly recorded_by?: string | null },
  member: { readonly tenantUserId?: string | null; readonly permissions?: readonly string[] },
): boolean {
  if ((member.permissions ?? []).includes(CORRECT_ANYONE)) return true;
  return Boolean(record.recorded_by) && record.recorded_by === member.tenantUserId;
}

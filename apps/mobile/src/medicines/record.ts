/**
 * Recording a dose on the phone (Phase 2 slice 69; ADR-0081; HZ-001, HZ-004). The carer chooses
 * the outcome and, where it has them, a coded reason (other and withheld need words); a dose given
 * needs the person positively identified (photo confirmation, or their wristband's token) and the
 * pack scanned and matched, or an override reason. The record is written to the phone's
 * `medication_administration` at once, so the round shows it recorded and "not synced yet", with
 * the request it will send in `request` (local only). `medicines-upload.ts` sends it to
 * `POST /v1/people/{id}/medicine-administrations`, where every rule is checked again.
 *
 * Pure, so every rule is tested without a device. Controlled drugs are recorded with a witness on
 * the same device in slice 70, so they are refused here.
 */
import {
  ADMINISTRATION_OUTCOMES,
  type AdministrationOutcome,
  OUTCOME_REASONS,
  type PackOverrideReason,
  type PointOfCareIssue,
  pointOfCareIssues,
} from "@harbour/domain";

export type RecordProblem =
  | PointOfCareIssue
  | "reason_required"
  | "note_required"
  | "amount_required"
  | "controlled_drug_on_phone"
  | "may_not_give";

export interface PackEvidence {
  readonly method: "scanned" | "override";
  readonly gtin: string | null;
  readonly batch: string | null;
  readonly expiry: string | null;
  readonly amppId: string | null;
  readonly override: { readonly code: PackOverrideReason; readonly note: string | null } | null;
}

export interface DoseRecordInput {
  /** The client's UUID (v7): the record's id here and on the server. */
  readonly id: string;
  readonly tenantId: string;
  readonly personId: string;
  readonly entryId: string;
  /** The scheduled dose (ISO), or null for a when-required dose. */
  readonly dueAt: string | null;
  readonly outcome: AdministrationOutcome;
  readonly reason: { readonly code: string; readonly note: string | null } | null;
  readonly amount: { readonly quantity: number; readonly unitCode: string } | null;
  readonly timingReason: string | null;
  readonly identity: "photo" | "wristband" | null;
  readonly pack: PackEvidence | null;
  /** The member recording (and giving) it. */
  readonly memberId: string;
  /** The device's clock, and its offset from the server at the last sync, when known. */
  readonly at: Date;
  readonly deviceOffsetMs: number | null;
  /** Whether the round allows giving from this entry now (`entryStatus.mayGive`). */
  readonly mayGive: boolean;
  readonly controlledDrug: boolean;
}

const GIVES = new Set<AdministrationOutcome>(["given"]);

/** What stops the record, in the order the screen shows them. */
export function recordProblems(input: DoseRecordInput): RecordProblem[] {
  const problems: RecordProblem[] = [];
  const gives = GIVES.has(input.outcome);
  if (gives && input.controlledDrug) problems.push("controlled_drug_on_phone");
  if (gives && !input.mayGive) problems.push("may_not_give");
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
  if (gives && !input.amount) problems.push("amount_required");
  problems.push(
    ...pointOfCareIssues(gives, {
      identity: input.identity,
      pack: input.pack?.method ?? null,
      packOverride: input.pack?.override ?? null,
    }),
  );
  return problems;
}

/** The body for `POST /v1/people/{id}/medicine-administrations` (RecordAdministration). */
export function recordRequestBody(input: DoseRecordInput): Record<string, unknown> {
  return {
    id: input.id,
    entryId: input.entryId,
    dueAt: input.dueAt,
    outcome: input.outcome,
    reason: input.reason
      ? { code: input.reason.code, note: input.reason.note?.trim() || null }
      : null,
    amount: input.amount,
    timingReason: input.timingReason?.trim() || null,
    givenAt: input.at.toISOString(),
    deviceOffsetMs: input.deviceOffsetMs,
    pointOfCare:
      input.identity || input.pack ? { identity: input.identity, pack: input.pack } : null,
  };
}

/** The row the phone writes, so the round shows the dose recorded and not yet synced. */
export function localAdministrationRow(input: DoseRecordInput): Record<string, string | null> {
  // The device's clock corrected by the last measured offset, as the server will store it.
  const givenAt = new Date(input.at.getTime() + (input.deviceOffsetMs ?? 0));
  return {
    id: input.id,
    tenant_id: input.tenantId,
    person_id: input.personId,
    medication_id: input.entryId,
    due_at: input.dueAt,
    outcome: input.outcome,
    reason_code: input.reason?.code ?? null,
    quantity: input.amount ? String(input.amount.quantity) : null,
    unit_code: input.amount?.unitCode ?? null,
    given_at: givenAt.toISOString(),
    administered_by: input.memberId,
    recorded_at: input.at.toISOString(),
    supersedes_id: null,
    request: JSON.stringify({ personId: input.personId, body: recordRequestBody(input) }),
  };
}

export function isOutcome(value: string): value is AdministrationOutcome {
  return (ADMINISTRATION_OUTCOMES as readonly string[]).includes(value);
}

/** The outcomes a carer chooses from on the phone (self-administration has its own record). */
export const PHONE_OUTCOMES: readonly AdministrationOutcome[] = [
  "given",
  "refused",
  "omitted",
  "not_available",
  "withheld",
];

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
  | "cd_signatures_required"
  | "cd_not_permitted"
  | "cd_witness_required"
  | "witness_is_recorder"
  | "may_not_give"
  | "inside_interval"
  | "over_24h_maximum"
  | "last_dose_unknown"
  | "pack_mismatch";

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
  /** A when-required dose's next allowed time, when later than now (HZ-004). */
  readonly nextAllowedAt?: Date | null;
  /** Its interval reaches before the records this phone holds, with none inside it (HZ-004). */
  readonly lastDoseNotOnDevice?: boolean;
  /**
   * What is left of a when-required dose's 24-hour maximum, in the dose's unit, from the records
   * this phone holds; null when it has none (HZ-004).
   */
  readonly prnRemaining?: number | null;
  /** The last scan was another medicine or an expired pack: no override clears it (HZ-113). */
  readonly packRefused?: boolean;
  /**
   * For a controlled drug given (ADR-0084; slice 70): the recorder's and the witness's signatures,
   * made on this phone with their own PINs over `cdDoseStatementText`.
   */
  readonly cdSignatures?: CdDeviceSignatures | null;
  /** Whether the member may record controlled drugs (`medicines.cd.administer`). */
  readonly mayRecordCd: boolean;
  /** The home's controlled drugs witness policy (`phoneWitnessPolicy`); unknown counts as required. */
  readonly witnessPolicy?: "required" | "where_available";
}

export interface CdDeviceSignatures {
  readonly recorder: {
    readonly keyId: string;
    readonly signature: string;
    readonly signedAt: string;
  };
  /** The witness's, made first when they saw the dose; null with why there was none. */
  readonly witness: {
    readonly keyId: string;
    readonly signature: string;
    readonly signedAt: string;
    readonly witnessId: string;
  } | null;
  /** Where the policy allows no witness, why (the register refuses it where one is required). */
  readonly noWitnessReason: string | null;
}

const GIVES = new Set<AdministrationOutcome>(["given"]);

/** What stops the record, in the order the screen shows them. */
export function recordProblems(input: DoseRecordInput): RecordProblem[] {
  const problems: RecordProblem[] = [];
  const gives = GIVES.has(input.outcome);
  // Checked before anything is given: a witness who may not record controlled drugs is never the
  // recorder; the API would refuse it only after the dose (HZ-116; lead's batch 5 review, 1).
  // Unknown counts as not permitted: only a recorder the phone knows may record it passes.
  const cdNotPermitted = gives && input.controlledDrug && input.mayRecordCd !== true;
  if (cdNotPermitted) problems.push("cd_not_permitted");
  // A controlled drug given needs the recorder's and a witness's signatures on this phone.
  if (gives && input.controlledDrug && !cdNotPermitted && !input.cdSignatures)
    problems.push("cd_signatures_required");
  // No witness only where the home's policy allows it: the register refuses it otherwise, after the
  // dose was given (HZ-116; lead's batch 5 review, B4).
  if (
    input.cdSignatures &&
    !input.cdSignatures.witness &&
    (input.witnessPolicy ?? "required") !== "where_available"
  ) {
    problems.push("cd_witness_required");
  }
  if (input.cdSignatures?.witness && input.cdSignatures.witness.witnessId === input.memberId) {
    problems.push("witness_is_recorder");
  }
  if (gives && !input.mayGive) problems.push("may_not_give");
  // The phone never records a dose inside the minimum interval, or when the last dose may be older
  // than its records: the nurse in charge decides, on the web with an override reason (clinical
  // review of slice 69, H4).
  if (gives && input.nextAllowedAt && input.nextAllowedAt.getTime() > input.at.getTime()) {
    problems.push("inside_interval");
  }
  if (gives && input.lastDoseNotOnDevice) problems.push("last_dose_unknown");
  // The amount typed is compared with what is left of the 24-hour maximum, before the dose is
  // given, never only "none left" (guides review of the phone, 08/11/2026; HZ-004).
  if (
    gives &&
    typeof input.prnRemaining === "number" &&
    input.amount &&
    input.amount.quantity > input.prnRemaining
  ) {
    problems.push("over_24h_maximum");
  }
  if (gives && input.packRefused) problems.push("pack_mismatch");
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
    // Judged at the time the phone recorded it, so a dose sent later is still a round record.
    deviceRecordedAt: input.at.toISOString(),
    deviceOffsetMs: input.deviceOffsetMs,
    // Always sent from the phone: the API requires it on a phone's upload (ADR-0081).
    pointOfCare: { identity: input.identity, pack: input.pack },
    controlledDrug: input.cdSignatures ? { deviceSignatures: input.cdSignatures } : null,
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
    recorded_by: input.memberId,
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

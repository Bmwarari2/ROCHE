/**
 * Per-organisation crypto-shredding (PLAT-012; platform.md, Crypto-shredding; ADR-0109). Pure:
 * who may request and approve a whole-organisation shred, and the certificate body that is hashed
 * and signed. Two different people, each with a fresh step-up; never while a legal hold is active.
 */

export const SHRED_REASON_MIN = 20;

export type ShredRequestProblem =
  | "step_up_required"
  | "reason_too_short"
  | "export_not_confirmed"
  | "legal_hold_active"
  | "already_pending";

export type ShredApprovalProblem =
  | "step_up_required"
  | "not_pending"
  | "same_person"
  | "legal_hold_active";

const MESSAGES: Record<ShredRequestProblem | ShredApprovalProblem, string> = {
  step_up_required: "Confirm it is you before shredding the organisation's records.",
  reason_too_short: `Give the reason in at least ${SHRED_REASON_MIN} characters.`,
  export_not_confirmed: "Confirm the organisation's full export has been taken first.",
  legal_hold_active: "A legal hold is in force: release it before shredding.",
  already_pending: "A shred is already waiting for approval.",
  not_pending: "This shred is no longer waiting for approval.",
  same_person: "A different person must approve the shred: you requested it.",
};

export type Refusal<P extends string> = {
  readonly ok: false;
  readonly problem: P;
  readonly message: string;
};
export type Verdict<P extends string> = { readonly ok: true } | Refusal<P>;

function refuse<P extends ShredRequestProblem | ShredApprovalProblem>(problem: P): Refusal<P> {
  return { ok: false, problem, message: MESSAGES[problem] };
}

export function checkShredRequest(input: {
  readonly stepUpFresh: boolean;
  readonly reason: string;
  readonly exportConfirmed: boolean;
  readonly activeHolds: number;
  readonly pendingRequests: number;
}): Verdict<ShredRequestProblem> {
  if (!input.stepUpFresh) return refuse("step_up_required");
  if (input.reason.trim().length < SHRED_REASON_MIN) return refuse("reason_too_short");
  if (!input.exportConfirmed) return refuse("export_not_confirmed");
  if (input.activeHolds > 0) return refuse("legal_hold_active");
  if (input.pendingRequests > 0) return refuse("already_pending");
  return { ok: true };
}

export function checkShredApproval(input: {
  readonly stepUpFresh: boolean;
  readonly status: string;
  readonly requestedBy: string;
  readonly approverId: string;
  readonly activeHolds: number;
}): Verdict<ShredApprovalProblem> {
  if (!input.stepUpFresh) return refuse("step_up_required");
  if (input.status !== "pending") return refuse("not_pending");
  if (input.requestedBy === input.approverId) return refuse("same_person");
  if (input.activeHolds > 0) return refuse("legal_hold_active");
  return { ok: true };
}

/** JSON with keys sorted at every level, so the same certificate always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export interface KeyVersionDestruction {
  /** The Cloud KMS key version (or local key version) name: opaque, no personal data. */
  readonly name: string;
  /** When the key material is destroyed for good (ISO 8601, UTC). */
  readonly destroyAt: string;
}

export interface CertificateInput {
  readonly id: string;
  readonly tenantId: string;
  readonly recordClass: string;
  readonly subjectType: string;
  readonly subjectIds: readonly string[];
  readonly recordCount: number;
  readonly retentionRule: unknown;
  readonly reason: string;
  readonly method: string;
  readonly executedAt: Date;
  readonly requestedBy?: string | null;
  readonly approvedBy?: string | null;
  readonly keyVersions?: readonly KeyVersionDestruction[];
  /** When the database's point-in-time recovery no longer holds the deleted rows. */
  readonly backupsExpireAt?: Date | null;
}

/** The certificate's signed body: every field the certificate states, in canonical form. */
export function certificateBody(input: CertificateInput): string {
  const keys = input.keyVersions ?? [];
  return canonicalJson({
    format: "harbour.destruction-certificate.v1",
    id: input.id,
    tenantId: input.tenantId,
    recordClass: input.recordClass,
    subjectType: input.subjectType,
    subjectIds: [...input.subjectIds].sort(),
    recordCount: input.recordCount,
    retentionRule: input.retentionRule ?? {},
    reason: input.reason,
    method: input.method,
    executedAt: input.executedAt.toISOString(),
    requestedBy: input.requestedBy ?? null,
    approvedBy: input.approvedBy ?? null,
    keyVersions: [...keys].sort((a, b) => (a.name < b.name ? -1 : 1)),
    keysDestroyedAt: keysDestroyedAt(keys)?.toISOString() ?? null,
    backupsExpireAt: input.backupsExpireAt?.toISOString() ?? null,
  });
}

/** The latest destroy time of the key versions: from then on, nothing can restore them. */
export function keysDestroyedAt(keys: readonly KeyVersionDestruction[]): Date | null {
  if (keys.length === 0) return null;
  return new Date(Math.max(...keys.map((k) => new Date(k.destroyAt).getTime())));
}

/** When point-in-time recovery no longer holds what was deleted at `executedAt`. */
export function backupsExpireAt(executedAt: Date, pitrDays: number): Date {
  return new Date(executedAt.getTime() + pitrDays * 86_400_000);
}

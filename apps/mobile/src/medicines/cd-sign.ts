/**
 * Signing a controlled drug's dose on this phone (ADR-0084; slice 70). The witness signs first,
 * when they see the dose given, with their own PIN: that fixes the record's id, the amount and the
 * time given. The recorder then records it with their own PIN. Each signs the same statement
 * (`cdDoseStatementText`) with their own role and time; the API checks the witness signed first and
 * within the witness window. A wrong PIN is counted on that person's key (and throttled). The
 * opened secret is wiped once used. Pure: the caller keeps the updated key.
 */
import { cdDoseStatementText } from "@harbour/domain";
import { signText, unlockKey, type WrappedKey } from "./device-key";

export type CdSignProblem =
  | { readonly kind: "no_key"; readonly who: "recorder" | "witness" }
  | { readonly kind: "wrong_pin"; readonly who: "recorder" | "witness" }
  | { readonly kind: "wait"; readonly who: "recorder" | "witness"; readonly until: Date };

export interface CdDoseFields {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly recorderId: string;
  readonly personId: string;
  readonly entryId: string;
  readonly administrationId: string;
  readonly vmpId: string;
  /** When the dose was given (the witness's signing time), ISO. */
  readonly givenAt: string;
  readonly quantity: number;
  readonly unitCode: string;
}

export interface MadeSignature {
  readonly keyId: string;
  readonly signature: string;
  readonly signedAt: string;
}

export type SignResult =
  | { readonly kind: "signed"; readonly signature: MadeSignature; readonly key: WrappedKey }
  | { readonly kind: "refused"; readonly problem: CdSignProblem; readonly key: WrappedKey | null };

export function signAs(
  role: "recorder" | "witness",
  key: WrappedKey | null,
  pin: string,
  dose: CdDoseFields,
  now: Date,
): SignResult {
  if (!key) return { kind: "refused", problem: { kind: "no_key", who: role }, key: null };
  const opened = unlockKey(key, pin, now);
  if (opened.kind === "wait") {
    return { kind: "refused", problem: { kind: "wait", who: role, until: opened.until }, key };
  }
  if (opened.kind === "wrong_pin") {
    return { kind: "refused", problem: { kind: "wrong_pin", who: role }, key: opened.key };
  }
  const signedAt = now.toISOString();
  const text = cdDoseStatementText({
    ...dose,
    role,
    signerId: opened.key.memberId,
    movement: "administration",
    signedAt,
  });
  const signature = signText(opened.secret, text);
  // The opened key never outlives its one signature (security review of slice 70, L3).
  opened.secret.fill(0);
  return {
    kind: "signed",
    signature: { keyId: opened.key.keyId, signature, signedAt },
    key: opened.key,
  };
}

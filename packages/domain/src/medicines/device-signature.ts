/**
 * Signatures on a controlled drug's dose made on a phone offline (ADR-0084; Phase 2 slice 70). The
 * recorder and the witness each sign the same statement on the same device with their own key,
 * unlocked by their own PIN; the server verifies both when the record arrives. The statement is one
 * fixed text, so the phone and the server sign and verify exactly the same bytes. Pure.
 */

export const CD_STATEMENT_VERSION = "harbour-cd-dose-v2";

export interface CdDoseStatement {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly role: "recorder" | "witness";
  /** Who signs: the recorder, or the witness. */
  readonly signerId: string;
  /** The member recording the dose (and giving it). */
  readonly recorderId: string;
  readonly personId: string;
  readonly entryId: string;
  /** The administration's client id. */
  readonly administrationId: string;
  /** What moved: an administration (the only movement signed on a phone today). */
  readonly movement: "administration";
  /** The medicine (its dm+d VMP). */
  readonly vmpId: string;
  /** When the dose was given, by the phone's clock (ISO). */
  readonly givenAt: string;
  /** The amount given, in the page's unit. */
  readonly quantity: number;
  readonly unitCode: string;
  /** When this signer signed, by the device's clock (ISO). */
  readonly signedAt: string;
}

/** The exact text each signer signs: one field a line, in this order. */
export function cdDoseStatementText(s: CdDoseStatement): string {
  return [
    CD_STATEMENT_VERSION,
    s.tenantId,
    s.deviceId,
    s.role,
    s.signerId,
    s.recorderId,
    s.personId,
    s.entryId,
    s.administrationId,
    s.movement,
    s.vmpId,
    new Date(s.givenAt).toISOString(),
    String(Number(s.quantity)),
    s.unitCode,
    new Date(s.signedAt).toISOString(),
  ].join("\n");
}

export type DeviceSignatureIssue =
  | "witness_is_recorder"
  | "key_not_for_signer"
  | "key_replaced"
  | "device_revoked"
  | "signed_before_enrolment"
  | "signed_in_future"
  | "signed_too_long_apart"
  | "signed_too_long_ago"
  | "witness_signed_after"
  | "signature_invalid";

export const DEVICE_SIGNATURE_WORDS: Readonly<Record<DeviceSignatureIssue, string>> = {
  witness_is_recorder:
    "The witness must be someone other than the person recording and giving the dose.",
  key_not_for_signer:
    "A signature was made with another member's key. Record it again with each person's own PIN.",
  key_replaced:
    "A signature was made with a PIN that had been replaced on this phone. Record it again.",
  device_revoked: "This phone's access was withdrawn, so its signatures cannot be used.",
  signed_before_enrolment:
    "A signature is older than the PIN that made it. Check the phone's clock.",
  signed_in_future: "A signature is dated in the future. Check the phone's clock.",
  signed_too_long_apart:
    "The witness and the recorder signed too far apart. The witness signs when they see the dose given.",
  witness_signed_after:
    "The witness signed after the dose was recorded. The witness signs when they see it given.",
  signed_too_long_ago:
    "A signature is older than this phone may keep records. Record the dose in Thapsus Care on the web.",
  signature_invalid:
    "A signature does not match what was recorded. Record it again with both PINs.",
};

export interface DeviceKeyFacts {
  readonly keyId: string;
  readonly keyMemberId: string;
  readonly keyDeviceId: string;
  readonly enrolledAt: Date;
  /** When a newer key for the same member and device was enrolled, if one was. */
  readonly replacedAt: Date | null;
}

/**
 * Why a device signature does not stand, or none. `verified` is the cryptographic check's result;
 * the rules here are the ones around it. `toleranceMs` is the clock-drift figure from the rate
 * table; `apartMs` how far apart the two signatures may be (the witness sees the dose given).
 */
export function deviceSignatureIssues(input: {
  readonly signerId: string;
  readonly deviceId: string;
  readonly signedAt: Date;
  readonly key: DeviceKeyFacts | null;
  readonly deviceRevokedAt: Date | null;
  readonly verified: boolean;
  readonly now: Date;
  readonly toleranceMs: number;
  /** The offline window from the rate table: no signature older than it is taken. */
  readonly windowMs: number;
}): DeviceSignatureIssue[] {
  const issues: DeviceSignatureIssue[] = [];
  const { key } = input;
  if (!key || key.keyMemberId !== input.signerId || key.keyDeviceId !== input.deviceId) {
    return ["key_not_for_signer"];
  }
  if (input.deviceRevokedAt && input.deviceRevokedAt.getTime() <= input.signedAt.getTime()) {
    issues.push("device_revoked");
  }
  if (key.replacedAt && key.replacedAt.getTime() <= input.signedAt.getTime())
    issues.push("key_replaced");
  if (input.signedAt.getTime() < key.enrolledAt.getTime() - input.toleranceMs) {
    issues.push("signed_before_enrolment");
  }
  if (input.signedAt.getTime() > input.now.getTime() + input.toleranceMs)
    issues.push("signed_in_future");
  if (!input.verified) issues.push("signature_invalid");
  return issues;
}

/** The two signatures together: different people, signed close together. */
export function pairIssues(input: {
  readonly recorderId: string;
  readonly witnessId: string;
  readonly recorderSignedAt: Date;
  readonly witnessSignedAt: Date;
  readonly apartMs: number;
}): DeviceSignatureIssue[] {
  const issues: DeviceSignatureIssue[] = [];
  // The witness signs when they see the dose, before the recorder records it (clinical review of
  // slice 70, H1): a witness signature after the recorder's is not one for a dose they saw.
  if (input.recorderId === input.witnessId) issues.push("witness_is_recorder");
  const apart = input.recorderSignedAt.getTime() - input.witnessSignedAt.getTime();
  if (apart < 0) issues.push("witness_signed_after");
  if (Math.abs(apart) > input.apartMs) issues.push("signed_too_long_apart");
  return issues;
}

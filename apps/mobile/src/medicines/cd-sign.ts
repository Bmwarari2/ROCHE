/**
 * Signing a controlled drug's dose on this phone (ADR-0084; slice 70): the recorder and the
 * witness each type their own PIN; each key signs the same statement (`cdDoseStatementText`) with
 * its own role and time. A wrong PIN is counted on that person's key (and throttled); nothing is
 * signed until both open. Pure: the caller keeps the updated keys.
 */
import { cdDoseStatementText } from "@harbour/domain";
import { signText, unlockKey, type WrappedKey } from "./device-key";
import type { CdDeviceSignatures } from "./record";

export type CdSignProblem =
  | { readonly kind: "no_key"; readonly who: "recorder" | "witness" }
  | { readonly kind: "wrong_pin"; readonly who: "recorder" | "witness" }
  | { readonly kind: "wait"; readonly who: "recorder" | "witness"; readonly until: Date };

export function signCdDose(input: {
  readonly recorderKey: WrappedKey | null;
  readonly recorderPin: string;
  readonly witnessKey: WrappedKey | null;
  readonly witnessPin: string;
  readonly dose: {
    readonly tenantId: string;
    readonly deviceId: string;
    readonly personId: string;
    readonly entryId: string;
    readonly administrationId: string;
    readonly quantity: number;
    readonly unitCode: string;
  };
  readonly now: Date;
}):
  | {
      readonly kind: "signed";
      readonly signatures: CdDeviceSignatures;
      readonly keys: WrappedKey[];
    }
  | { readonly kind: "refused"; readonly problem: CdSignProblem; readonly keys: WrappedKey[] } {
  const keys: WrappedKey[] = [];
  type Opened =
    | { readonly ok: false; readonly problem: CdSignProblem }
    | { readonly ok: true; readonly secret: Uint8Array; readonly key: WrappedKey };
  const open = (who: "recorder" | "witness", key: WrappedKey | null, pin: string): Opened => {
    if (!key) return { ok: false, problem: { kind: "no_key", who } };
    const r = unlockKey(key, pin, input.now);
    if (r.kind === "wait") return { ok: false, problem: { kind: "wait", who, until: r.until } };
    keys.push(r.key);
    if (r.kind === "wrong_pin") return { ok: false, problem: { kind: "wrong_pin", who } };
    return { ok: true, secret: r.secret, key: r.key };
  };
  const recorder = open("recorder", input.recorderKey, input.recorderPin);
  if (!recorder.ok) return { kind: "refused", problem: recorder.problem, keys };
  const witness = open("witness", input.witnessKey, input.witnessPin);
  if (!witness.ok) return { kind: "refused", problem: witness.problem, keys };
  const signedAt = input.now.toISOString();
  const recorderId = recorder.key.memberId;
  const sign = (role: "recorder" | "witness", signerId: string, secret: Uint8Array) =>
    signText(secret, cdDoseStatementText({ ...input.dose, role, signerId, recorderId, signedAt }));
  return {
    kind: "signed",
    keys,
    signatures: {
      recorder: {
        keyId: recorder.key.keyId,
        signature: sign("recorder", recorderId, recorder.secret),
        signedAt,
      },
      witness: {
        keyId: witness.key.keyId,
        signature: sign("witness", witness.key.memberId, witness.secret),
        signedAt,
        witnessId: witness.key.memberId,
      },
    },
  };
}

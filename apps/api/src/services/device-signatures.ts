/**
 * Signatures made on a phone offline (ADR-0084; Phase 2 slice 70): verifying a recorder's and a
 * witness's ECDSA P-256 signatures over a controlled drug's dose, made on the same phone with each
 * member's own PIN-unlocked key, and turning a verified witness signature into the register's own
 * witness assertion (`device_factor`), so the rest of the register path is the web's. Keys are read
 * in the system's view (`withSystemRights`): a recorder may not otherwise read a witness's key.
 */
import { createPublicKey, verify } from "node:crypto";
import {
  controlledDrugWitnessAssertion,
  deviceBinding,
  memberDeviceKey,
  type Transaction,
} from "@harbour/db";
import {
  cdDoseStatementText,
  DEVICE_SIGNATURE_WORDS,
  type DeviceKeyFacts,
  type DeviceSignatureIssue,
  deviceSignatureIssues,
  pairIssues,
} from "@harbour/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { personReachedBy } from "./devices";
import { withSystemRights } from "./system-rights";

export interface DeviceSignatureInput {
  readonly keyId: string;
  readonly signature: string;
  readonly signedAt: string;
}

export interface DeviceSignaturesInput {
  readonly recorder: DeviceSignatureInput;
  readonly witness: DeviceSignatureInput & { readonly witnessId: string };
}

/** Verifies an ECDSA P-256 signature (r||s) with an uncompressed public key, both base64. */
export function verifyP256(publicKeyB64: string, text: string, signatureB64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, "base64");
    if (raw.length !== 65 || raw[0] !== 4) return false;
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: raw.subarray(1, 33).toString("base64url"),
        y: raw.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    return verify(
      "sha256",
      Buffer.from(text, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}

async function keyFacts(
  tx: Transaction,
  keyId: string,
): Promise<(DeviceKeyFacts & { publicKey: string }) | null> {
  return withSystemRights(tx, async () => {
    const [key] = await tx.select().from(memberDeviceKey).where(eq(memberDeviceKey.id, keyId));
    if (!key) return null;
    const [newer] = await tx
      .select({ enrolledAt: memberDeviceKey.enrolledAt })
      .from(memberDeviceKey)
      .where(
        and(
          eq(memberDeviceKey.deviceId, key.deviceId),
          eq(memberDeviceKey.tenantUserId, key.tenantUserId),
          // Compared in the database: its microseconds would make a key newer than itself
          // when read back into a JavaScript date.
          sql`${memberDeviceKey.enrolledAt} > (SELECT k.enrolled_at FROM member_device_key k WHERE k.id = ${key.id})`,
        ),
      )
      .orderBy(asc(memberDeviceKey.enrolledAt))
      .limit(1);
    return {
      keyId: key.id,
      keyMemberId: key.tenantUserId,
      keyDeviceId: key.deviceId,
      enrolledAt: key.enrolledAt,
      replacedAt: newer?.enrolledAt ?? null,
      publicKey: key.publicKey,
    };
  });
}

async function deviceRevokedAt(tx: Transaction, deviceId: string): Promise<Date | null> {
  return withSystemRights(tx, async () => {
    const rows = await tx
      .select({ revokedAt: deviceBinding.revokedAt })
      .from(deviceBinding)
      .where(eq(deviceBinding.deviceId, deviceId));
    const times = rows.flatMap((r) => (r.revokedAt ? [r.revokedAt.getTime()] : []));
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  });
}

export interface DeviceDose {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly recorderId: string;
  readonly personId: string;
  readonly entryId: string;
  readonly administrationId: string;
  readonly quantity: number;
  readonly unitCode: string;
  readonly locationId: string;
}

export type DeviceProblem = { readonly problem: string; readonly message: string };

const asProblems = (issues: readonly DeviceSignatureIssue[], who: string): DeviceProblem[] =>
  issues.map((i) => ({ problem: `${who}_${i}`, message: DEVICE_SIGNATURE_WORDS[i] }));

/**
 * Checks both signatures and the witness's standing when they signed: `medicines.cd.witness` at the
 * person's home, and current medicines competence. Returns the problems in words; none means both
 * stand. `witnessCompetent` is the competence port's answer for the witness at their signing time.
 */
export async function deviceSignatureProblems(
  tx: Transaction,
  dose: DeviceDose,
  signatures: DeviceSignaturesInput,
  rules: {
    readonly now: Date;
    readonly toleranceMs: number;
    readonly apartMs: number;
    readonly witnessCompetent: (at: Date) => Promise<boolean>;
  },
): Promise<DeviceProblem[]> {
  const revokedAt = await deviceRevokedAt(tx, dose.deviceId);
  const check = async (
    role: "recorder" | "witness",
    signerId: string,
    s: DeviceSignatureInput,
  ): Promise<DeviceSignatureIssue[]> => {
    const key = await keyFacts(tx, s.keyId);
    const text = cdDoseStatementText({ ...dose, role, signerId, signedAt: s.signedAt });
    return deviceSignatureIssues({
      signerId,
      deviceId: dose.deviceId,
      signedAt: new Date(s.signedAt),
      key,
      deviceRevokedAt: revokedAt,
      verified: key ? verifyP256(key.publicKey, text, s.signature) : false,
      now: rules.now,
      toleranceMs: rules.toleranceMs,
    });
  };
  const { recorder, witness } = signatures;
  const problems = [
    ...asProblems(await check("recorder", dose.recorderId, recorder), "recorder"),
    ...asProblems(await check("witness", witness.witnessId, witness), "witness"),
    ...asProblems(
      pairIssues({
        recorderId: dose.recorderId,
        witnessId: witness.witnessId,
        recorderSignedAt: new Date(recorder.signedAt),
        witnessSignedAt: new Date(witness.signedAt),
        apartMs: rules.apartMs,
      }),
      "pair",
    ),
  ];
  if (problems.length > 0) return problems;
  const signedAt = new Date(witness.signedAt);
  const mayWitness = await withSystemRights(tx, () =>
    personReachedBy(
      tx,
      witness.witnessId,
      dose.personId,
      signedAt,
      signedAt,
      "medicines.cd.witness",
    ),
  );
  if (!mayWitness) {
    problems.push({
      problem: "witness_not_permitted",
      message: "The witness could not witness controlled drugs here when they signed.",
    });
  } else if (!(await rules.witnessCompetent(signedAt))) {
    problems.push({
      problem: "witness_not_competent",
      message: "Only someone whose medicines competence is current can witness.",
    });
  }
  return problems;
}

/**
 * The witness assertion a verified device signature stands for, written now and used by the entry
 * at once, exactly as a web witness's assertion is (`assertionProblem`, `writeCdEntry`).
 */
export async function deviceWitnessAssertion(
  tx: Transaction,
  input: {
    readonly personId: string;
    readonly pageId: string;
    readonly quantity: number;
    readonly administrationId: string;
    readonly recorderId: string;
    readonly witness: DeviceSignatureInput & { readonly witnessId: string };
    readonly expiresAt: Date;
  },
): Promise<string> {
  const [row] = await tx
    .insert(controlledDrugWitnessAssertion)
    .values({
      personId: input.personId,
      pageId: input.pageId,
      movement: "administration",
      quantity: String(input.quantity),
      administrationId: input.administrationId,
      witnessId: input.witness.witnessId,
      recorderId: input.recorderId,
      expiresAt: input.expiresAt,
      method: "device_factor",
      deviceKeyId: input.witness.keyId,
      signature: input.witness.signature,
      signedAt: new Date(input.witness.signedAt),
    })
    .returning({ id: controlledDrugWitnessAssertion.id });
  return (row as { id: string }).id;
}

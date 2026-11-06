import { createHash } from "node:crypto";
import { destructionCertificate, type Transaction } from "@harbour/db";
import {
  backupsExpireAt,
  type CertificateInput,
  certificateBody,
  keysDestroyedAt,
  type TenantKeyPort,
} from "@harbour/domain";
import { sql } from "drizzle-orm";
import type { Config } from "../config";

/**
 * Signed destruction certificates (PLAT-012, ADR-0109). The body is the canonical JSON of every
 * field the certificate states (`certificateBody`); its SHA-256 and Harbour's certificate key's
 * signature over it are stored beside it, so anyone holding the public key can show the
 * certificate has not been changed. Opaque ids only: no names, no document titles.
 */

export type CertificateRow = typeof destructionCertificate.$inferSelect;

export interface IssueCertificate
  extends Omit<CertificateInput, "id" | "backupsExpireAt" | "signatureKey" | "signatureAlgorithm"> {
  /** Days after which no backup holds what was deleted (`backupDays`). */
  readonly backupDays: number;
}

/**
 * The longer of the point-in-time recovery window and the backup retention (both required in
 * production; 7 elsewhere): after this many days no backup holds deleted rows (review L6).
 */
export function backupDays(config: Config): number {
  return Math.max(config.DATABASE_PITR_DAYS ?? 7, config.DATABASE_BACKUP_RETENTION_DAYS ?? 7);
}

/** Signs and inserts one certificate in the caller's transaction. */
export async function issueCertificate(
  tx: Transaction,
  keys: TenantKeyPort,
  input: IssueCertificate,
): Promise<CertificateRow> {
  const [{ id }] = (await tx.execute<{ id: string }>(sql`SELECT app.uuid_v7() AS id`)).rows as [
    { id: string },
  ];
  const { backupDays: days, ...rest } = input;
  const signer = keys.signer();
  const full: CertificateInput = {
    ...rest,
    id,
    backupsExpireAt: backupsExpireAt(input.executedAt, days),
    signatureKey: signer.key,
    signatureAlgorithm: signer.algorithm,
  };
  const body = Buffer.from(certificateBody(full), "utf8");
  const signed = await keys.sign(body);
  // The signature is checked before it is stored: a corrupted or mismatched one never is.
  if (
    signed.key !== signer.key ||
    signed.algorithm !== signer.algorithm ||
    !(await keys.verify(body, signed.signature, signed.key))
  ) {
    throw new Error("certificate signature did not verify");
  }
  const keyVersions = [...(input.keyVersions ?? [])];
  const [row] = await tx
    .insert(destructionCertificate)
    .values({
      id,
      tenantId: input.tenantId,
      recordClass: input.recordClass,
      subjectType: input.subjectType,
      subjectIds: [...input.subjectIds],
      recordCount: input.recordCount,
      retentionRule: input.retentionRule ?? {},
      reason: input.reason,
      method: input.method,
      executedAt: input.executedAt,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      signature: signed.signature,
      signatureKey: signed.key,
      signatureAlgorithm: signed.algorithm,
      keyVersions,
      keysDestroyedAt: keysDestroyedAt(keyVersions),
      backupsExpireAt: full.backupsExpireAt ?? null,
      requestedBy: input.requestedBy ?? null,
      approvedBy: input.approvedBy ?? null,
    })
    .returning();
  if (!row) throw new Error("certificate not inserted");
  return row;
}

/** The body a stored certificate was signed over, rebuilt from its row (for verification). */
export function storedCertificateBody(row: CertificateRow): string {
  return certificateBody({
    id: row.id,
    tenantId: row.tenantId,
    recordClass: row.recordClass,
    subjectType: row.subjectType,
    subjectIds: row.subjectIds,
    recordCount: row.recordCount,
    retentionRule: row.retentionRule,
    reason: row.reason,
    method: row.method,
    executedAt: row.executedAt,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    keyVersions: (row.keyVersions as CertificateInput["keyVersions"]) ?? [],
    backupsExpireAt: row.backupsExpireAt,
    signatureKey: row.signatureKey,
    signatureAlgorithm: row.signatureAlgorithm,
  });
}

/** Whether a stored certificate's signature verifies over its rebuilt body (unsigned: null). */
export async function verifyCertificate(
  keys: TenantKeyPort,
  row: CertificateRow,
): Promise<{ readonly valid: boolean | null; readonly body: string }> {
  const body = storedCertificateBody(row);
  if (!row.signature || !row.signatureKey || !row.bodySha256) return { valid: null, body };
  const bytes = Buffer.from(body, "utf8");
  const hashMatches = createHash("sha256").update(bytes).digest("hex") === row.bodySha256;
  return {
    valid: hashMatches && (await keys.verify(bytes, row.signature, row.signatureKey)),
    body,
  };
}

/** A certificate as the API returns it. */
export function certificateItem(cert: CertificateRow) {
  return {
    id: cert.id,
    tenantId: cert.tenantId,
    subjectIds: cert.subjectIds,
    retentionRule: (cert.retentionRule ?? {}) as Record<string, unknown>,
    recordClass: cert.recordClass,
    subjectType: cert.subjectType,
    recordCount: cert.recordCount,
    reason: cert.reason,
    method: cert.method,
    executedAt: cert.executedAt.toISOString(),
    bodySha256: cert.bodySha256,
    signature: cert.signature,
    signatureKey: cert.signatureKey,
    signatureAlgorithm: cert.signatureAlgorithm,
    keyVersions: (cert.keyVersions as { name: string; destroyAt: string }[]) ?? [],
    keysDestroyedAt: cert.keysDestroyedAt?.toISOString() ?? null,
    backupsExpireAt: cert.backupsExpireAt?.toISOString() ?? null,
    requestedBy: cert.requestedBy,
    approvedBy: cert.approvedBy,
  };
}

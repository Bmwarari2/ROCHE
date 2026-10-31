import { describe, expect, it } from "vitest";
import { certificatePdf, certificatePdfLines } from "./certificate-pdf";
import type { CertificateRow } from "./certificates";

/** The destruction certificate PDF (PLAT-012 part 2; platform.md rule 12). */

const ID = "0194e000-0000-7000-8000-0000000000c1";
const row = {
  id: ID,
  tenantId: "0194e000-0000-7000-8000-0000000000a1",
  recordClass: "organisation_exit",
  subjectType: "tenant",
  subjectIds: ["0194e000-0000-7000-8000-0000000000a1"],
  recordCount: 2,
  retentionRule: {},
  reason: "The contract has ended and the full export was downloaded.",
  method: "kms_key_destroy:local",
  executedAt: new Date("2026-10-31T12:00:00Z"),
  bodySha256: "a".repeat(64),
  signature: "c2lnbmF0dXJl",
  signatureKey: "local/certificate-signing/1",
  signatureAlgorithm: "ED25519",
  keyVersions: [{ name: "tenant-key/v1", destroyAt: "2026-11-30T12:00:00Z" }],
  keysDestroyedAt: new Date("2026-11-30T12:00:00Z"),
  backupsExpireAt: new Date("2026-11-07T12:00:00Z"),
  requestedBy: "0194e000-0000-7000-8000-0000000000b1",
  approvedBy: "0194e000-0000-7000-8000-0000000000b2",
} as unknown as CertificateRow;
const BUILT = new Date("2026-12-01T09:00:00Z");
const text = (valid: boolean | null, r: CertificateRow = row) =>
  certificatePdfLines(r, { valid, body: '{"format":"harbour.destruction-certificate.v1"}' }, BUILT)
    .map((l) => l.text)
    .join("\n");

describe("the destruction certificate PDF", () => {
  it.each([
    [true, "Signature checked"],
    [false, "Signature does not match"],
    [null, "Not signed"],
  ] as const)("states the signature check (%s) near the top", (valid, words) => {
    const lines = certificatePdfLines(row, { valid, body: "{}" }, BUILT);
    expect(lines.slice(0, 6).map((l) => l.text)).toContain(words);
  });

  it("carries the signer key version, algorithm, hash, signature, signed body and backup expiry", () => {
    const all = text(true);
    for (const part of [
      "local/certificate-signing/1",
      "ED25519",
      "a".repeat(64),
      "c2lnbmF0dXJl",
      '{"format":"harbour.destruction-certificate.v1"}',
      "tenant-key/v1",
      "Database backups no longer hold the deleted records after 07/11/2026",
      `/v1/destruction-certificates/${ID}/verification`,
    ]) {
      expect(all).toContain(part);
    }
  });

  it("says plainly that database records are not removed by a whole-organisation shred", () => {
    expect(text(true)).toContain("Records in the database are not removed by this");
  });

  it("names nobody: members by opaque id only", () => {
    expect(text(true)).not.toMatch(/@|Ada|Example/);
  });

  it("builds a PDF", () => {
    const bytes = certificatePdf(row, { valid: true, body: "{}" }, BUILT);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});

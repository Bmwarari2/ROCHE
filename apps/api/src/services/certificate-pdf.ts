import { formatUkDateTimeWithZone } from "@harbour/domain";
import type { CertificateRow } from "./certificates";
import { type PdfLine, renderPdf } from "./pdf";

/**
 * A destruction certificate as a PDF (PLAT-012 part 2; platform.md, Crypto-shredding screens rule
 * 12). Built on request from the stored, signed record by the API's PDF writer, as the evidence and
 * transfer packs are, and never stored: after a whole-organisation shred the organisation's
 * document store no longer opens. It states the signature check made when it was built, so a
 * reader sees at once whether to rely on it, and carries everything needed to check it
 * independently: the signing key version, the algorithm, the SHA-256, the signature and the exact
 * signed body. Opaque ids and the reason only; no names.
 */

export interface CertificateCheck {
  /** True: verified; false: does not match; null: not signed. */
  readonly valid: boolean | null;
  /** The canonical body the signature covers. */
  readonly body: string;
}

const KEY_DESTRUCTION = /^kms_key_destroy/;

function checkWords(valid: boolean | null): { title: string; detail: string } {
  if (valid === true) {
    return {
      title: "Signature checked",
      detail: "This certificate has not been changed since Harbour signed it.",
    };
  }
  if (valid === false) {
    return {
      title: "Signature does not match",
      detail:
        "Do not rely on this certificate: it does not match what Harbour signed. Tell Thapsus Cargo Ltd.",
    };
  }
  return {
    title: "Not signed",
    detail:
      "This certificate was issued before Harbour signed certificates, so it cannot be checked.",
  };
}

function whatWasDestroyed(row: CertificateRow): string {
  if (row.subjectType === "tenant") {
    return "Every stored document, export and data request bundle of the organisation. The organisation's encryption keys were scheduled for destruction, so none of them can be opened again; the key material is destroyed for good when the destruction delay ends. Records in the database are not removed by this: they are deleted under the retention schedule.";
  }
  const records = row.recordCount === 1 ? "1 record" : `${row.recordCount} records`;
  return `${records} of class ${row.recordClass} (${row.subjectType}), deleted with every stored version.`;
}

/** The certificate's lines, in order (pure, for tests). */
export function certificatePdfLines(
  row: CertificateRow,
  check: CertificateCheck,
  builtAt: Date,
): PdfLine[] {
  const words = checkWords(check.valid);
  const keyVersions = (row.keyVersions as { name: string; destroyAt: string }[] | null) ?? [];
  const lines: PdfLine[] = [
    { text: "Destruction certificate", bold: true, size: 14 },
    { text: `Certificate ${row.id}` },
    { text: `Organisation ${row.tenantId}` },
    { text: `Carried out ${formatUkDateTimeWithZone(row.executedAt)}.` },
    { text: words.title, bold: true, size: 12, gapBefore: 8 },
    { text: words.detail },
    {
      text: `Checked ${formatUkDateTimeWithZone(builtAt)}, when this PDF was made, against Harbour's certificate key.`,
      size: 9,
    },
    { text: "What was destroyed", bold: true, gapBefore: 10 },
    { text: whatWasDestroyed(row) },
    { text: `Method: ${row.method}.` },
    { text: `Reason: ${row.reason}` },
    { text: "Who", bold: true, gapBefore: 10 },
    {
      text: row.requestedBy
        ? `Requested by member ${row.requestedBy}; approved by member ${row.approvedBy ?? "not recorded"}. Two different people, each confirming it was them.`
        : "Carried out by the organisation's retention process.",
    },
  ];
  if (KEY_DESTRUCTION.test(row.method) || keyVersions.length > 0) {
    lines.push({ text: "Keys destroyed", bold: true, gapBefore: 10 });
    for (const key of keyVersions) {
      lines.push({
        text: `${key.name}: destroyed for good ${formatUkDateTimeWithZone(new Date(key.destroyAt))}.`,
      });
    }
    if (row.keysDestroyedAt) {
      lines.push({
        text: `After ${formatUkDateTimeWithZone(row.keysDestroyedAt)} nobody can restore the keys, Thapsus Cargo Ltd and Google included.`,
      });
    }
  }
  lines.push(
    { text: "Backups", bold: true, gapBefore: 10 },
    {
      text: row.backupsExpireAt
        ? `Database backups no longer hold the deleted records after ${formatUkDateTimeWithZone(row.backupsExpireAt)}.`
        : "The date backups expire was not recorded on this certificate.",
    },
    { text: "Signature", bold: true, gapBefore: 10 },
    { text: `Signing key version: ${row.signatureKey ?? "none"}` },
    { text: `Algorithm: ${row.signatureAlgorithm ?? "none"}` },
    { text: `SHA-256 of the signed body: ${row.bodySha256 ?? "none"}` },
    { text: `Signature (base64): ${row.signature ?? "none"}`, size: 8 },
    { text: "How to check it yourself", bold: true, gapBefore: 10 },
    {
      text: `Take the signed body below exactly as printed (UTF-8, no added spaces or line breaks: the lines are broken only to fit the page), check its SHA-256, then verify the signature with Harbour's published certificate public key. Harbour also checks it at /v1/destruction-certificates/${row.id}/verification.`,
    },
    { text: "Signed body", bold: true, gapBefore: 10 },
    { text: check.body, size: 8 },
  );
  return lines;
}

/** The PDF bytes. */
export function certificatePdf(row: CertificateRow, check: CertificateCheck, builtAt: Date) {
  return renderPdf({
    title: "Destruction certificate",
    header: [`Destruction certificate ${row.id}. ${checkWords(check.valid).title}.`],
    lines: certificatePdfLines(row, check, builtAt),
    footer: (n, total) => `Certificate ${row.id}. Page ${n} of ${total}.`,
  });
}

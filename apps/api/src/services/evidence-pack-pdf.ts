import { EVIDENCE_REDACTION_TEXT } from "@harbour/domain";
import type { BundleContent, EvidencePackRow, StoredField } from "./evidence-pack";
import { type PdfLine, renderPdf } from "./pdf";

/**
 * The evidence pack as the recipient reads it (quality.md rules 3 and 5; ADR-0040; HZ-050), drawn
 * with the pack PDF writer from the manifest and the bundle alone: only included items, each field
 * with the value the pack shows, or, where it is redacted or withheld, the reason in words. The
 * watermark is on every page. Nothing is stored: the PDF is drawn when it is opened.
 */

interface PdfItem {
  readonly id: string;
  readonly title: string;
  readonly occurredAt: Date;
  readonly qualityStatementIds: readonly string[];
  readonly fields: readonly StoredField[];
}

const ukDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

function fieldLine(field: StoredField, value: string | undefined): string {
  const reason = field.reason ? EVIDENCE_REDACTION_TEXT[field.reason] : null;
  if (field.outcome === "withheld" || value === undefined) {
    return `${field.label}: ${reason ?? EVIDENCE_REDACTION_TEXT.person_unknown}`;
  }
  return reason ? `${field.label}: ${value} (${reason})` : `${field.label}: ${value}`;
}

export function renderEvidencePackPdf(
  pack: Pick<
    EvidencePackRow,
    | "id"
    | "recipientName"
    | "recipientOrganisation"
    | "purpose"
    | "dateFrom"
    | "dateTo"
    | "watermark"
  >,
  items: readonly PdfItem[],
  bundle: BundleContent,
): Uint8Array {
  const shown = [...items].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const lines: PdfLine[] = [
    { text: "Evidence pack", bold: true, size: 14 },
    { text: `For ${pack.recipientName}, ${pack.recipientOrganisation}.` },
    { text: `Purpose: ${pack.purpose}` },
    { text: `Records from ${ukDate(pack.dateFrom)} to ${ukDate(pack.dateTo)}.` },
    { text: `${shown.length} ${shown.length === 1 ? "record" : "records"}.` },
    {
      text: "Where a detail is redacted or withheld, the reason is given. Ask the provider if you need something that is withheld.",
      gapBefore: 4,
    },
  ];
  for (const item of shown) {
    lines.push({ text: item.title, bold: true, gapBefore: 10 });
    if (item.qualityStatementIds.length > 0) {
      lines.push({ text: `Quality statements: ${item.qualityStatementIds.join(", ")}`, size: 8 });
    }
    const values = bundle[item.id] ?? {};
    for (const field of item.fields) lines.push({ text: fieldLine(field, values[field.key]) });
  }
  return renderPdf({
    title: "Evidence pack",
    header: [pack.watermark],
    lines,
    footer: (n, total) => `Pack ${pack.id}. Page ${n} of ${total}. Do not share further.`,
  });
}

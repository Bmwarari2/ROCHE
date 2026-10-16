import { EVIDENCE_REDACTION_TEXT, formatUkDateTimeWithZone } from "@harbour/domain";
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

/** A field the manifest shows but the bundle holds no value for (#66 clinical review L2). */
const NOT_AVAILABLE = "Withheld: not available in this pack.";

/**
 * The watermark as composed, with its time relabelled "Composed" and given GMT or BST, and the
 * release time beside it (#66 clinical review; HZ-050, H-222).
 */
export function packHeader(
  pack: Pick<EvidencePackRow, "watermark" | "composedAt" | "releasedAt">,
): string {
  const released = pack.releasedAt ? ` Released ${formatUkDateTimeWithZone(pack.releasedAt)}.` : "";
  const composed = `Composed ${formatUkDateTimeWithZone(pack.composedAt)}.${released}`;
  return /Made [^.]+\.(?= Pack )/.test(pack.watermark)
    ? pack.watermark.replace(/Made [^.]+\.(?= Pack )/, composed)
    : `${pack.watermark} ${composed}`;
}

const ukDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

function fieldLine(field: StoredField, value: string | undefined): string {
  const reason = field.reason ? EVIDENCE_REDACTION_TEXT[field.reason] : null;
  if (field.outcome === "withheld") {
    return `${field.label}: ${reason ?? NOT_AVAILABLE}`;
  }
  if (value === undefined) return `${field.label}: ${NOT_AVAILABLE}`;
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
    | "composedAt"
    | "releasedAt"
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
      text: pack.releasedAt
        ? `Released ${formatUkDateTimeWithZone(pack.releasedAt)}. This pack shows the records as they stood when it was released; a correction made since is not in it.`
        : "Not released.",
      bold: true,
      gapBefore: 4,
    },
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
    header: [packHeader(pack)],
    lines,
    footer: (n, total) => `Pack ${pack.id}. Page ${n} of ${total}. Do not share further.`,
  });
}

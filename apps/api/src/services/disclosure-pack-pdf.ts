import { formatUkDateTimeWithZone } from "@harbour/domain";
import { type PdfLine, renderPdf } from "./pdf";

/**
 * A released disclosure pack as a PDF to hand over (safety.md Phase 2 rule 6; H-958, recommended
 * answer applied 31/10/2026). Built from the pack exactly as it was issued and stored, never from
 * the live records: the records in date order, each field as released (redacted fields read
 * "[redacted]"), the counts withheld and redacted, and the pack's fingerprint (SHA-256) on every
 * page, so the recipient and the provider can show the copy is the one released. The caller has
 * already checked the fingerprint against the stored pack.
 */

export interface StoredDisclosurePack {
  readonly requestId: string;
  readonly type: string;
  readonly legalBasis: string;
  readonly generatedAt: string;
  readonly records: readonly {
    readonly table: string;
    readonly recordId: string;
    readonly when: string | null;
    readonly fields: Readonly<Record<string, unknown>>;
  }[];
  readonly redactedCount: number;
  readonly withheldCount: number;
  readonly notSearched: readonly { readonly table: string; readonly guidance: string }[];
  readonly sha256: string;
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "Not recorded";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function whenText(when: string | null): string {
  if (!when) return "Date not recorded";
  const at = new Date(when);
  return Number.isNaN(at.getTime()) ? when : formatUkDateTimeWithZone(at);
}

export function renderDisclosurePackPdf(
  pack: StoredDisclosurePack,
  request: {
    readonly recipientOrganisation: string;
    readonly releasedAt: Date;
    readonly downloadedAt: Date;
  },
): Uint8Array {
  const lines: PdfLine[] = [
    { text: "Disclosure pack", bold: true, size: 14 },
    { text: `For ${request.recipientOrganisation}.` },
    { text: `Legal basis: ${pack.legalBasis}` },
    { text: `Released ${formatUkDateTimeWithZone(request.releasedAt)}.` },
    {
      text: `${pack.records.length} ${pack.records.length === 1 ? "record" : "records"} disclosed; ${pack.redactedCount} with details redacted; ${pack.withheldCount} withheld.`,
    },
    { text: `Fingerprint (SHA-256): ${pack.sha256}`, bold: true, gapBefore: 4 },
    {
      text: "This pack shows the records exactly as they were released. Give it only through the recipient's secure route, never by ordinary email.",
      gapBefore: 4,
    },
  ];
  if (pack.notSearched.length > 0) {
    lines.push({ text: "Not searched", bold: true, gapBefore: 8 });
    for (const n of pack.notSearched) lines.push({ text: `${n.table}: ${n.guidance}` });
  }
  for (const record of pack.records) {
    lines.push({ text: `${whenText(record.when)}: ${record.table}`, bold: true, gapBefore: 10 });
    lines.push({ text: `Record ${record.recordId}`, size: 8 });
    for (const [key, value] of Object.entries(record.fields)) {
      lines.push({ text: `${key}: ${valueText(value)}` });
    }
  }
  return renderPdf({
    title: "Disclosure pack",
    header: [
      `Disclosure pack ${pack.requestId}. Fingerprint ${pack.sha256}. Downloaded ${formatUkDateTimeWithZone(request.downloadedAt)}.`,
    ],
    lines,
    footer: (n, total) => `Page ${n} of ${total}. Confidential: do not share further.`,
  });
}

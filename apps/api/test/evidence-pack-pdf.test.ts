import { EVIDENCE_REDACTION_TEXT } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import type { BundleContent, StoredField } from "../src/services/evidence-pack";
import { packHeader, renderEvidencePackPdf } from "../src/services/evidence-pack-pdf";
import { pdfPages } from "./support/pdf-text";

/**
 * The inspector evidence pack as rendered (Phase 1 gate: "inspector pack export renders"; quality.md
 * rules 3 and 5; ADR-0040; hazard HZ-050), from a fixed manifest and bundle with no database: the
 * watermark and the page footer on every page, only the values the bundle holds, each withheld or
 * redacted field with its reason in words, and records in time order. The API test
 * (`evidence-link.test.ts`) opens the same render through the recipient's link.
 */

const PACK = {
  id: "0194f000-0000-7000-8000-00000000e001",
  recipientName: "Ivy Inspector",
  recipientOrganisation: "CQC",
  purpose: "Assessment of Harbour House, safe key question",
  dateFrom: "2026-10-01",
  dateTo: "2026-10-14",
  watermark:
    "Prepared for Ivy Inspector, CQC. Purpose: Assessment of Harbour House, safe key question. Made 15/10/2026 09:00. Pack 0194f000.",
  composedAt: new Date("2026-10-15T08:00:00Z"),
  releasedAt: new Date("2026-10-15T13:30:00Z"),
};

const field = (key: string, label: string, extra: Partial<StoredField> = {}): StoredField => ({
  key,
  label,
  kind: "care_content",
  outcome: "included",
  ...extra,
});

const NOTE = {
  id: "item-note",
  title: "Care note: nutrition",
  occurredAt: new Date("2026-10-03T12:00:00Z"),
  qualityStatementIds: ["S1"],
  fields: [
    field("summary", "Summary"),
    field("body", "Note", {
      kind: "free_text",
      outcome: "withheld",
      reason: "free_text_not_reviewed",
    }),
    field("author", "Written by", {
      kind: "staff_name",
      outcome: "redacted",
      reason: "staff_role_only",
    }),
    field("nhs", "NHS number", {
      kind: "direct_identifier",
      outcome: "withheld",
      reason: "identifier_not_needed",
    }),
    field("missing", "Fluid target"),
  ],
};

const EARLIER = {
  id: "item-earlier",
  title: "Observation: weight",
  occurredAt: new Date("2026-10-02T09:00:00Z"),
  qualityStatementIds: [],
  fields: [field("reading", "Weight")],
};

const BUNDLE = {
  "item-note": {
    summary: "Ate most of lunch with encouragement.",
    // A value stored for a withheld field is never printed.
    body: "Gwen Visitor brought her a sandwich.",
    author: "Senior carer",
  },
  "item-earlier": { reading: "61.2 kg" },
};

const render = (items = [NOTE, EARLIER], bundle: BundleContent = BUNDLE) =>
  pdfPages(renderEvidencePackPdf(PACK, items, bundle)).map((page) => page.join("\n"));

describe("hazard HZ-050 the evidence pack renders", () => {
  it("prints the recipient, purpose, dates, count and release, with records in time order", () => {
    const [first = ""] = render();
    expect(first).toContain("Evidence pack");
    expect(first).toContain("For Ivy Inspector, CQC.");
    expect(first).toContain("Purpose: Assessment of Harbour House, safe key question");
    expect(first).toContain("Records from 01/10/2026 to 14/10/2026.");
    expect(first).toContain("2 records.");
    expect(first.replace(/\s+/g, " ")).toContain("Released 15/10/2026 14:30 BST.");
    expect(first.indexOf("Observation: weight")).toBeLessThan(
      first.indexOf("Care note: nutrition"),
    );
    expect(first).toContain("Quality statements: S1");
  });

  it("prints each field's value, or its reason in words, and never a withheld value", () => {
    const text = render().join("\n").replace(/\s+/g, " ");
    expect(text).toContain("Summary: Ate most of lunch with encouragement.");
    expect(text).toContain(`Note: ${EVIDENCE_REDACTION_TEXT.free_text_not_reviewed}`);
    expect(text).toContain(`Written by: Senior carer (${EVIDENCE_REDACTION_TEXT.staff_role_only})`);
    expect(text).toContain(`NHS number: ${EVIDENCE_REDACTION_TEXT.identifier_not_needed}`);
    // In the manifest but not in the bundle: said, never left blank.
    expect(text).toContain("Fluid target: Withheld: not available in this pack.");
    expect(text).not.toContain("Gwen Visitor");
  });

  it("carries the watermark, relabelled with the composed and released times, and the footer on every page", () => {
    const many = Array.from({ length: 40 }, (_, n) => ({
      ...EARLIER,
      id: `item-${n}`,
      occurredAt: new Date(Date.UTC(2026, 9, 2, 9, n)),
    }));
    const bundle = Object.fromEntries(many.map((item) => [item.id, { reading: "61.2 kg" }]));
    const pages = render(many, bundle);
    expect(pages.length).toBeGreaterThan(1);
    const header = packHeader(PACK);
    expect(header).toContain("Composed 15/10/2026 09:00 BST. Released 15/10/2026 14:30 BST.");
    expect(header).not.toContain("Made ");
    pages.forEach((page, n) => {
      const flat = page.replace(/\s+/g, " ");
      expect(flat).toContain("Prepared for Ivy Inspector, CQC.");
      expect(flat).toContain(
        `Pack ${PACK.id}. Page ${n + 1} of ${pages.length}. Do not share further.`,
      );
    });
  });

  it("is a well-formed PDF whose page tree matches its pages, the same bytes every time", () => {
    const bytes = renderEvidencePackPdf(PACK, [NOTE, EARLIER], BUNDLE);
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.startsWith("%PDF-")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Type /Catalog");
    const pages = pdfPages(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(raw).toContain(`/Count ${pages.length}`);
    expect(raw.match(/\/Type \/Page\b(?!s)/g)).toHaveLength(pages.length);
    // Nothing in the render reads the clock, and items are sorted by time: the same manifest,
    // in any order, gives the same file.
    const again = renderEvidencePackPdf(PACK, [EARLIER, NOTE], BUNDLE);
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });

  it("prints the pack's headings in order: the title, the recipient, then each record", () => {
    const text = render().join("\n");
    const headings = [
      "Evidence pack",
      "For Ivy Inspector, CQC.",
      "Observation: weight",
      "Care note: nutrition",
    ];
    const at = headings.map((heading) => text.indexOf(heading));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("Where a detail is redacted or withheld, the reason is given.");
  });

  it("says when a pack is not released, and counts one record in the singular", () => {
    const [first = ""] = pdfPages(
      renderEvidencePackPdf({ ...PACK, releasedAt: null }, [EARLIER], BUNDLE),
    ).map((page) => page.join("\n"));
    expect(first).toContain("1 record.");
    expect(first).toContain("Not released.");
  });
});

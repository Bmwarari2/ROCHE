import { formatNhsNumber } from "@harbour/domain";
import { marPrintedNotice } from "./mar-pdf";
import { type PdfLine, renderPdf } from "./pdf";
import { ukDate, ukDateTime } from "./transfer-pack-pdf";

/**
 * A controlled drugs register page as a PDF (Phase 2 slice 50; MEDS-014; medicines.md section 17).
 * It replaces slice 54's plain print view (H-1331). It shows:
 * - the page heading: the person, the drug as dm+d names it, and its unit;
 * - every entry in order, with its movement, quantity and running balance, when it happened, who
 *   recorded and witnessed it (or why there was no witness), and the counterparty and reference;
 * - each correction saying which entry it corrects, and each entry which entries correct it;
 * - every stock check with its result in words.
 *
 * Every page says when it was printed and that it is not the live record (HZ-122). Never an edit:
 * a correction is a later entry, shown as such.
 */

export interface CdPrintEntry {
  readonly id: string;
  readonly seq: number;
  readonly movement: string;
  readonly quantity: number;
  readonly balanceAfter: number;
  readonly correctsId: string | null;
  readonly corrects: "quantity" | "detail" | null;
  readonly reason: string | null;
  readonly counterparty: string | null;
  readonly reference: string | null;
  readonly occurredAt: string;
  readonly recorded: { readonly id: string; readonly at: string };
  readonly witnessId: string | null;
  readonly noWitnessReason: string | null;
}

export interface CdPrintCheck {
  readonly counted: number;
  readonly expected: number;
  readonly resultInWords: string;
  readonly reason: string | null;
  readonly checked: { readonly id: string; readonly at: string };
  readonly witnessId: string | null;
  readonly noWitnessReason: string | null;
}

export interface CdPrintInput {
  readonly person: {
    readonly name: string;
    readonly dateOfBirth: string | null;
    readonly nhsNumber: string | null;
    readonly locationName: string;
  };
  readonly page: {
    readonly productName: string;
    readonly unitName: string;
    readonly balance: number;
  };
  readonly entries: readonly CdPrintEntry[];
  readonly stockChecks: readonly CdPrintCheck[];
  /** Everyone who signed the page, by name. */
  readonly people: readonly { readonly id: string; readonly name: string }[];
  readonly printedAt: Date;
}

const MOVEMENT_WORDS: Readonly<Record<string, string>> = {
  receipt: "Received",
  administration: "Given",
  disposal: "Disposed of",
  transfer_out: "Transferred out",
  destruction: "Destroyed",
  correction: "Correction",
};

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

/** Every line of the page, in order: the PDF draws them, and tests read them. */
export function cdRegisterLines(input: CdPrintInput): PdfLine[] {
  const name = (id: string | null) =>
    id ? (input.people.find((p) => p.id === id)?.name ?? "a member of staff") : null;
  const witness = (id: string | null, none: string | null) =>
    id ? `witnessed by ${name(id)}` : none ? `no witness: ${none}` : "no witness recorded";
  const unit = input.page.unitName;
  const lines: PdfLine[] = [
    { text: `Controlled drugs register: ${input.page.productName}`, bold: true, size: 14 },
    { text: marPrintedNotice(input.printedAt), bold: true },
    {
      text: `${input.person.name}. Born ${ukDate(input.person.dateOfBirth)}. NHS number ${
        input.person.nhsNumber ? formatNhsNumber(input.person.nhsNumber) : "not recorded"
      }. ${input.person.locationName}.`,
    },
    { text: `Unit: ${unit}. Balance when printed: ${input.page.balance} ${unit}.` },
    { text: "Entries", bold: true, gapBefore: 8 },
  ];
  if (input.entries.length === 0) lines.push({ text: "No entry on this page." });
  const seqOf = (id: string | null) => input.entries.find((x) => x.id === id)?.seq;
  // Every entry in register order, so the running balance reads in order; a correction says which
  // entry it corrects (a correction of a correction too), never moved (clinical review B3).
  for (const e of [...input.entries].sort((x, y) => x.seq - y.seq)) {
    const corrected = seqOf(e.correctsId);
    lines.push({
      text: `${e.seq}. ${MOVEMENT_WORDS[e.movement] ?? e.movement} ${signed(e.quantity)} ${unit}, balance ${e.balanceAfter} ${unit}. ${ukDateTime(e.occurredAt)}.${
        e.counterparty ? ` ${e.counterparty}.` : ""
      }${e.reference ? ` Reference ${e.reference}.` : ""}${
        e.correctsId
          ? ` Corrects the ${e.corrects ?? "record"} of ${corrected ? `entry ${corrected}` : "an earlier entry"}.`
          : ""
      }${e.reason ? ` Reason: ${e.reason}.` : ""}${
        input.entries.some((x) => x.correctsId === e.id)
          ? ` Corrected by entry ${input.entries
              .filter((x) => x.correctsId === e.id)
              .map((x) => x.seq)
              .join(", ")}.`
          : ""
      } Recorded by ${name(e.recorded.id)} at ${ukDateTime(e.recorded.at)}, ${witness(e.witnessId, e.noWitnessReason)}.`,
    });
  }
  lines.push({ text: "Stock checks", bold: true, gapBefore: 8 });
  if (input.stockChecks.length === 0) lines.push({ text: "No stock check on this page." });
  for (const s of input.stockChecks) {
    lines.push({
      text: `${ukDateTime(s.checked.at)}: counted ${s.counted} ${unit}, expected ${s.expected} ${unit}. ${s.resultInWords}.${
        s.reason ? ` Reason: ${s.reason}.` : ""
      } Counted by ${name(s.checked.id)}, ${witness(s.witnessId, s.noWitnessReason)}.`,
    });
  }
  return lines;
}

export function renderCdRegisterPdf(input: CdPrintInput): Uint8Array {
  const heading = `${input.person.name}, controlled drugs register: ${input.page.productName}`;
  return renderPdf({
    title: "Controlled drugs register page",
    header: [heading, marPrintedNotice(input.printedAt)],
    lines: cdRegisterLines(input),
    footer: (page, pages) => `${heading}. Page ${page} of ${pages}`,
  });
}

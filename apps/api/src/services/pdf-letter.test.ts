import { describe, expect, it } from "vitest";
import { pdfPlacedLines } from "../../test/support/pdf-text";
import { LETTER_LAYOUT, renderPdf } from "./pdf";

const MM = 72 / 25.4;
const PAGE_HEIGHT = 842;
const fromTopMm = (y: number) => (PAGE_HEIGHT - y) / MM;

const letter = {
  letterhead: [
    "Example Care",
    "Example Care Homes Ltd",
    "1 Example Street",
    "Sampleford",
    "SF1 1SF",
    "Telephone 01234 567890",
  ],
  address: ["Kit Sample", "2 Example Road", "Exampletown", "EX1 1EX"],
};

const render = () =>
  renderPdf({
    title: "Letter",
    lines: Array.from({ length: 80 }, (_, n) => ({ text: `Line ${n + 1} of the letter.` })),
    footer: (n, total) => `Page ${n} of ${total}.`,
    letter,
  });

describe("hazard HZ-051 a posted letter's letterhead and window-envelope address (H-228)", () => {
  const [first = [], second = []] = pdfPlacedLines(render());
  const L = LETTER_LAYOUT;
  // A line's text sits below its baseline's start: a line in the window starts within the window.
  const inWindow = (l: { x: number; y: number }) =>
    l.x >= L.addressLeftMm * MM - 0.5 &&
    l.x <= (L.addressLeftMm + L.addressWidthMm) * MM &&
    fromTopMm(l.y) > L.addressTopMm &&
    fromTopMm(l.y) <= L.addressTopMm + L.addressHeightMm;

  it("places every line of the recipient's address inside the envelope's window", () => {
    const address = first.filter((l) => letter.address.includes(l.text));
    expect(address.map((l) => l.text)).toEqual(letter.address);
    for (const line of address) expect(inWindow(line), line.text).toBe(true);
  });

  it("shows nothing else through the window", () => {
    const others = first.filter((l) => !letter.address.includes(l.text));
    for (const line of others) expect(inWindow(line), line.text).toBe(false);
  });

  it("puts the provider's letterhead at the top right, clear of the window, on page 1 only", () => {
    const head = first.filter((l) => letter.letterhead.includes(l.text));
    expect(head.map((l) => l.text)).toEqual(letter.letterhead);
    for (const line of head) {
      expect(line.x).toBeGreaterThanOrEqual(L.letterheadLeftMm * MM - 0.5);
      expect(fromTopMm(line.y)).toBeLessThan(L.addressTopMm);
    }
    expect(second.some((l) => letter.letterhead.includes(l.text))).toBe(false);
  });

  it("starts the letter's text below the window on page 1, and at the top on later pages", () => {
    const body = first.filter((l) => l.text.startsWith("Line "));
    expect(Math.min(...body.map((l) => fromTopMm(l.y)))).toBeGreaterThan(L.bodyTopMm);
    const later = second.filter((l) => l.text.startsWith("Line "));
    expect(Math.min(...later.map((l) => fromTopMm(l.y)))).toBeLessThan(L.bodyTopMm / 2);
    expect(first.at(-1)?.text).toMatch(/^Page 1 of \d+\.$/);
  });
});

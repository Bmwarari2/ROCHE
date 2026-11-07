/**
 * The printable MAR on the web (slice 50; MEDS-014; medicines.md section 17): the months a chart may
 * be printed for, newest first, as the API takes them (yyyy-mm, UK calendar).
 */

/** This month and the eleven before it, in UK time, with their names ("November 2026"). */
export function printableMonths(now: Date = new Date()): { value: string; label: string }[] {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  let year = Number(parts.find((p) => p.type === "year")?.value);
  let month = Number(parts.find((p) => p.type === "month")?.value);
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < 12; i++) {
    const label = new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, 15)));
    out.push({ value: `${year}-${String(month).padStart(2, "0")}`, label });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

export const marPrintHref = (personId: string) => `/people/${personId}/medicines/mar/print`;
export const cdPdfHref = (personId: string, pageId: string) =>
  `/people/${personId}/controlled-drugs/${pageId}/pdf`;

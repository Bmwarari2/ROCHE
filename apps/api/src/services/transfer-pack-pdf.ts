import { ABOUT_ME_SECTIONS, formatNhsNumber } from "@harbour/domain";
import { type PdfImage, type PdfLine, renderPdf } from "./pdf";

/**
 * The printed hospital transfer pack (people.md rule 10; HZ-001, HZ-023). The first page names the
 * person and lists every safety-critical section that is not recorded; every page carries the
 * name, date of birth, NHS number and when the pack was made. Copied from the stored pack and
 * never interpreted (medical-device boundary). Dates are dd/mm/yyyy and times 24-hour UK time.
 */

/** The pack as stored on `hospital_transfer.pack` (dates as ISO strings). */
export interface StoredPack {
  readonly personId: string;
  readonly generatedAt: string;
  readonly identity: {
    readonly givenName: string;
    readonly familyName: string;
    readonly preferredName: string | null;
    readonly dateOfBirth: string | null;
    readonly nhsNumber: string | null;
  };
  readonly sections: readonly {
    readonly key: string;
    readonly title: string;
    readonly critical: boolean;
    readonly status: "included" | "not_recorded";
    readonly asOf: string | null;
  }[];
  readonly content: Record<string, unknown>;
  readonly missingCritical: readonly string[];
  readonly itemsLeftBehind: readonly { readonly description: string }[];
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function ukDateTime(iso: string | null | undefined): string {
  if (!iso) return "not recorded";
  const d = new Date(iso);
  return `${dateFormat.format(d)} ${timeFormat.format(d)}`;
}

function ukDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "not recorded";
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

type Names = ReadonlyMap<string, string>;
const who = (names: Names, id: unknown) =>
  typeof id === "string" ? (names.get(id) ?? "a member of staff") : "a member of staff";

const NOT_RECORDED = "Not recorded.";

function sectionLines(key: string, content: Record<string, unknown>, names: Names): string[] {
  const c = content[toContentKey(key)] as Record<string, unknown> | null | undefined;
  switch (key) {
    case "photo":
      return c
        ? ["Photo held in the record (shown on the first page when it is a JPEG)."]
        : [NOT_RECORDED];
    case "allergies": {
      if (!c || c.status === "unknown") return [`${NOT_RECORDED} Allergy status unknown.`];
      if (c.status === "no_known_allergies") {
        return [
          `No known allergies (recorded by ${who(names, c.recordedBy)} on ${ukDateTime(String(c.recordedAt))}).`,
        ];
      }
      const list =
        (c.allergies as { substance: string; severity: string; reaction: string | null }[]) ?? [];
      return list.map(
        (a) => `${a.substance}: ${a.severity}${a.reaction ? `. Reaction: ${a.reaction}` : ""}`,
      );
    }
    case "medicines": {
      if (!c || c.status === "not_recorded") return [NOT_RECORDED];
      if (c.status === "none") {
        return [
          `No current medicines (confirmed by ${who(names, c.confirmedBy)} on ${ukDateTime(String(c.confirmedAt))}).`,
        ];
      }
      const items =
        (c.items as {
          name: string;
          dose: string;
          route: string;
          frequency: string;
          timeCritical: boolean;
        }[]) ?? [];
      return [
        "From the medicines list taken at pre-admission: check against the latest supply.",
        ...items.map(
          (m) =>
            `${m.timeCritical ? "TIME-CRITICAL: " : ""}${m.name}, ${m.dose}, ${m.route}, ${m.frequency}`,
        ),
      ];
    }
    case "communication": {
      if (!c || c.status === "not_recorded") return [NOT_RECORDED];
      if (c.status === "none_identified") {
        return [
          `No communication needs identified (confirmed by ${who(names, c.confirmedBy)} on ${ukDateTime(String(c.confirmedAt))}).`,
        ];
      }
      const needs = (c.needs as { display: string; preferredFormat: string }[]) ?? [];
      return needs.map((n) => `${n.display}${n.preferredFormat ? ` (${n.preferredFormat})` : ""}`);
    }
    case "resuscitation": {
      if (!c || c.status === "not_recorded") return [NOT_RECORDED];
      if (c.status === "no_decision_in_place") {
        return [
          `No resuscitation decision in place (confirmed by ${who(names, c.confirmedBy)} on ${ukDateTime(String(c.confirmedAt))}).`,
        ];
      }
      const records =
        (c.records as {
          kind: string;
          summary: string;
          clinician: string;
          completedOn: string;
          reviewOn: string | null;
        }[]) ?? [];
      return records.map(
        (r) =>
          `${r.kind.toUpperCase()}: ${r.summary}. ${r.clinician}. Completed ${ukDate(r.completedOn)}${r.reviewOn ? `, review ${ukDate(r.reviewOn)}` : ""}.`,
      );
    }
    case "about_me": {
      const document = (c?.document ?? null) as Record<
        string,
        { text?: string | null } | null
      > | null;
      if (!document) return [NOT_RECORDED];
      const lines = ABOUT_ME_SECTIONS.flatMap((s) => {
        const text = document[s.key]?.text?.trim();
        return text ? [`${s.title}: ${text}`] : [];
      });
      return lines.length > 0 ? lines : [NOT_RECORDED];
    }
    case "reason_for_transfer":
      return typeof content.reasonForTransfer === "string"
        ? [content.reasonForTransfer]
        : [NOT_RECORDED];
    case "baseline":
      return c && typeof c.description === "string" ? [c.description] : [NOT_RECORDED];
    case "eating_and_drinking":
      return c
        ? [
            `Food: IDDSI level ${c.foodLevel ?? "not recorded"}. Drinks: IDDSI level ${c.drinkLevel ?? "not recorded"}.`,
            ...(typeof c.notes === "string" ? [c.notes] : []),
          ]
        : [NOT_RECORDED];
    case "capacity_and_legal":
      return c
        ? [String(c.summary), `DoLS authorisation in force: ${c.dolsInPlace ? "yes" : "no"}.`]
        : [NOT_RECORDED];
    case "contacts": {
      const contacts =
        (content.contacts as {
          name: string;
          relationship: string | null;
          role: string;
          phone: string | null;
        }[]) ?? [];
      return contacts.length > 0
        ? contacts.map(
            (x) =>
              `${x.name} (${[x.relationship, x.role.replaceAll("_", " ")].filter(Boolean).join(", ")})${x.phone ? `: ${x.phone}` : ""}`,
          )
        : [NOT_RECORDED];
    }
    case "infection":
      return c && typeof c.summary === "string" ? [c.summary] : [NOT_RECORDED];
    case "items_sent": {
      const items = (content.itemsSent as { description: string; quantity?: number }[]) ?? [];
      return items.length > 0 ? items.map((i) => i.description) : ["Nothing sent with the person."];
    }
    case "home_contact":
      return c ? [`${c.locationName}: ${c.phone}`] : [NOT_RECORDED];
    default:
      return [];
  }
}

/** Pack section keys are snake_case; the content object uses the domain's camelCase names. */
function toContentKey(key: string): string {
  let out = "";
  let upper = false;
  for (const ch of key) {
    if (ch === "_") {
      upper = true;
      continue;
    }
    out += upper ? ch.toUpperCase() : ch;
    upper = false;
  }
  return out;
}

export interface PackPrint {
  readonly pack: StoredPack;
  readonly hospitalName: string;
  readonly locationName: string;
  readonly names: Names;
  readonly photo: PdfImage | null;
  readonly printedAt: Date;
}

export function renderTransferPackPdf(print: PackPrint): Uint8Array {
  const { pack, names } = print;
  const id = pack.identity;
  const name = `${id.familyName.toUpperCase()}, ${id.givenName}${id.preferredName ? ` (known as ${id.preferredName})` : ""}`;
  const nhs = id.nhsNumber ? formatNhsNumber(id.nhsNumber) : "not recorded";
  const lines: PdfLine[] = [
    { text: "Hospital transfer pack", bold: true, size: 16 },
    { text: name, bold: true, size: 13, gapBefore: 6 },
    { text: `Date of birth: ${ukDate(id.dateOfBirth)}` },
    { text: `NHS number: ${nhs}` },
    { text: `From: ${print.locationName}. To: ${print.hospitalName}.` },
    {
      text: `Made from the record at ${ukDateTime(pack.generatedAt)}; printed at ${ukDateTime(print.printedAt.toISOString())}.`,
    },
  ];
  const missing = pack.sections.filter((s) => s.critical && s.status === "not_recorded");
  if (missing.length > 0) {
    lines.push({
      text: "NOT RECORDED: safety-critical information missing from the record",
      bold: true,
      size: 12,
      gapBefore: 10,
    });
    for (const s of missing) lines.push({ text: `${s.title}: not recorded`, bold: true });
  } else {
    lines.push({
      text: "Every safety-critical section is recorded.",
      bold: true,
      gapBefore: 10,
    });
  }
  for (const section of pack.sections) {
    lines.push({
      text: `${section.title}${section.status === "included" && section.asOf ? ` (as of ${ukDateTime(section.asOf)})` : ""}`,
      bold: true,
      size: 11,
      gapBefore: 8,
    });
    for (const text of sectionLines(section.key, pack.content, names)) lines.push({ text });
    if (section.key === "items_sent" && pack.itemsLeftBehind.length > 0) {
      for (const item of pack.itemsLeftBehind) {
        lines.push({ text: `Held at the home, not sent: ${item.description}` });
      }
    }
  }
  return renderPdf({
    title: "Hospital transfer pack",
    lines,
    image: print.photo,
    footer: (page, pages) =>
      `${name} - born ${ukDate(id.dateOfBirth)} - NHS ${nhs} - made ${ukDateTime(pack.generatedAt)} - page ${page} of ${pages}`,
  });
}

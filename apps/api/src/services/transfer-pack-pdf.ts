import {
  ABOUT_ME_SECTIONS,
  describeIddsiLevel,
  formatNhsNumber,
  iddsiLevel,
  isUkClockChangeDay,
  toUkWallClock,
  ukZoneAbbreviation,
} from "@harbour/domain";
import { type ImageObject, type PdfLine, renderPdf } from "./pdf";
import { unprintableCharacters } from "./pdf-font";

/**
 * The printed hospital transfer pack (people.md rule 10; HZ-001, HZ-007, HZ-015, HZ-016, HZ-023).
 * The first page names the person and lists every safety-critical section that is not recorded,
 * everything recorded that needs checking (resuscitation records that disagree, an overdue
 * review, a medicines list from before admission, a photo that cannot be printed), and any
 * section with characters the font cannot print; every page carries the name, date of birth, NHS
 * number and when the pack was made. Copied from the stored pack and never interpreted
 * (medical-device boundary). Dates are dd/mm/yyyy and times 24-hour UK time, with BST or GMT on
 * the two days the clocks change.
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
  /** Absent on packs stored before slice 8's review. */
  readonly attention?: readonly {
    readonly key: string;
    readonly code: string;
    readonly message: string;
    readonly onDate: string | null;
  }[];
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

/** dd/mm/yyyy hh:mm in UK time; BST or GMT is added on a clock-change day (HZ-009). */
export function ukDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "not recorded";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "not recorded";
  const w = toUkWallClock(d);
  const zone = isUkClockChangeDay(w.year, w.month, w.day) ? ` ${ukZoneAbbreviation(d)}` : "";
  return `${dateFormat.format(d)} ${timeFormat.format(d)}${zone}`;
}

/** dd/mm/yyyy: a yyyy-mm-dd date as written, or an instant's UK calendar date. */
export function ukDate(value: string | Date | null | undefined): string {
  if (!value) return "not recorded";
  if (value instanceof Date) return dateFormat.format(value);
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

type Names = ReadonlyMap<string, string>;
const who = (names: Names, id: unknown) =>
  typeof id === "string" ? (names.get(id) ?? "a member of staff") : null;

const NOT_RECORDED = "Not recorded.";

/** What a missing safety-critical section says on the first page. */
const NOT_RECORDED_WORDING: Record<string, string> = {
  medicines: "Medicines: not recorded since admission. Check the MAR.",
  resuscitation: "Resuscitation (CPR decision): not recorded.",
  photo: "Photo: not recorded or cannot be printed. Confirm identity another way.",
};

interface AdvanceRecord {
  readonly kind: string;
  readonly summary: string;
  readonly clinician: string;
  readonly completedOn: string;
  readonly reviewOn: string | null;
}

const KIND_NAMES: Record<string, string> = {
  respect: "ReSPECT",
  dnacpr: "DNACPR",
  adrt: "Advance decision to refuse treatment",
  advance_care_plan: "Advance care plan",
};

const advanceLine = (r: AdvanceRecord) =>
  `${KIND_NAMES[r.kind] ?? r.kind}: ${r.summary}. ${r.clinician}. Completed ${ukDate(r.completedOn)}${r.reviewOn ? `, review due ${ukDate(r.reviewOn)}` : ""}.`;

function iddsi(kind: "food" | "drink", code: unknown): string {
  if (typeof code !== "string") return "not recorded";
  return iddsiLevel(kind, code) ? describeIddsiLevel(kind, code) : `code ${code}`;
}

function sectionLines(key: string, content: Record<string, unknown>, names: Names): string[] {
  const c = content[toContentKey(key)] as Record<string, unknown> | null | undefined;
  switch (key) {
    case "photo":
      if (!c) return [NOT_RECORDED];
      return c.printable === false
        ? [
            `A photo taken on ${ukDate(String(c.takenOn))} is held in the record but cannot be printed.`,
          ]
        : [`Photo taken on ${ukDate(String(c.takenOn))}, on the first page.`];
    case "allergies": {
      if (!c || c.status === "unknown") return [`${NOT_RECORDED} Allergy status unknown.`];
      if (c.status === "no_known_allergies") {
        const by = who(names, c.recordedBy);
        return [
          by && c.recordedAt
            ? `No known allergies (confirmed by ${by} on ${ukDateTime(String(c.recordedAt))}).`
            : "No known allergies (who confirmed this, and when, is not recorded: check).",
        ];
      }
      const list =
        (c.allergies as { substance: string; severity: string; reaction: string | null }[]) ?? [];
      return list.map(
        (a) => `${a.substance}: ${a.severity}${a.reaction ? `. Reaction: ${a.reaction}` : ""}`,
      );
    }
    case "medicines": {
      if (!c || c.status === "not_recorded") {
        return ["Medicines not recorded since admission. Check the MAR."];
      }
      if (c.status === "none") {
        return [
          `No current medicines (confirmed by ${who(names, c.confirmedBy) ?? "a member of staff"} on ${ukDateTime(String(c.confirmedAt))}).`,
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
        ...(c.source === "pre_admission_assessment" || c.source === "medicines_list"
          ? ["From the pre-admission assessment, not the MAR: check against the MAR."]
          : []),
        ...items.map(
          (m) =>
            `${m.timeCritical ? "TIME-CRITICAL: " : ""}${m.name}, ${m.dose}, ${m.route}, ${m.frequency}`,
        ),
      ];
    }
    case "communication": {
      if (!c || c.status === "not_recorded") return [NOT_RECORDED];
      const by = who(names, c.confirmedBy);
      const confirmed =
        by && c.confirmedAt ? ` (confirmed by ${by} on ${ukDateTime(String(c.confirmedAt))})` : "";
      if (c.status === "none_identified") return [`No communication needs identified${confirmed}.`];
      const needs = (c.needs as { display: string; preferredFormat: string }[]) ?? [];
      return [
        ...needs.map((n) => `${n.display}${n.preferredFormat ? ` (${n.preferredFormat})` : ""}`),
        ...(confirmed ? [`Recorded${confirmed}.`] : []),
      ];
    }
    case "resuscitation": {
      if (!c) return [NOT_RECORDED];
      const others = ((c.otherRecords as AdvanceRecord[] | undefined) ?? []).map(advanceLine);
      if (c.status === "not_recorded") return ["CPR decision: not recorded.", ...others];
      if (c.status === "no_decision_in_place") {
        return [
          `No resuscitation decision in place (confirmed by ${who(names, c.confirmedBy) ?? "a member of staff"} on ${ukDateTime(String(c.confirmedAt))}).`,
        ];
      }
      if (Array.isArray(c.cprRecords)) {
        const cpr = (c.cprRecords as AdvanceRecord[]).map(advanceLine);
        const decision =
          c.decision === "do_not_attempt_cpr"
            ? "Not for cardiopulmonary resuscitation"
            : "For cardiopulmonary resuscitation";
        return [
          c.conflicting
            ? "CPR decision: THE RECORDS DISAGREE. Check the original documents. Both are listed."
            : `CPR decision: ${decision}.`,
          ...(c.reviewOverdue ? [`Review was due on ${ukDate(String(c.reviewDueOn))}.`] : []),
          ...cpr,
          ...others,
        ];
      }
      // A pack stored before the CPR decision was printed separately.
      return ((c.records as AdvanceRecord[] | undefined) ?? []).map(advanceLine);
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
            `Food: IDDSI ${iddsi("food", c.foodLevel)}.`,
            `Drinks: IDDSI ${iddsi("drink", c.drinkLevel)}.`,
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
  /** The photo ready to print, or null when there is none or it could not be read. */
  readonly photo: ImageObject | null;
  readonly printedAt: Date;
}

export function renderTransferPackPdf(print: PackPrint): Uint8Array {
  const { pack, names } = print;
  const id = pack.identity;
  const name = `${id.familyName.toUpperCase()}, ${id.givenName}${id.preferredName ? ` (known as ${id.preferredName})` : ""}`;
  const nhs = id.nhsNumber ? formatNhsNumber(id.nhsNumber) : "not recorded";

  // Each section's printed lines first, so the first page can name what needs attention.
  const body: { title: string; lines: string[]; heading: PdfLine }[] = pack.sections.map(
    (section) => {
      const lines = sectionLines(section.key, pack.content, names);
      if (section.key === "items_sent") {
        for (const item of pack.itemsLeftBehind) {
          lines.push(`Held at the home, not sent: ${item.description}`);
        }
      }
      return {
        title: section.title,
        lines,
        heading: {
          text: `${section.title}${section.status === "included" && section.asOf ? ` (as of ${ukDateTime(section.asOf)})` : ""}`,
          bold: true,
          size: 11,
          gapBefore: 8,
        },
      };
    },
  );
  const unprintable = [
    ...(unprintableCharacters(name).length > 0 ? ["Name"] : []),
    ...body.filter((s) => unprintableCharacters(s.lines.join(" ")).length > 0).map((s) => s.title),
  ];
  const photoPrinted = print.photo !== null;
  const photoHeld = pack.content.photo !== null && pack.content.photo !== undefined;

  const lines: PdfLine[] = [
    { text: "Hospital transfer pack", bold: true, size: 16 },
    { text: name, bold: true, size: 13, gapBefore: 6 },
    { text: `Date of birth: ${ukDate(id.dateOfBirth)}` },
    { text: `NHS number: ${nhs}` },
    { text: `From: ${print.locationName}. To: ${print.hospitalName}.` },
    {
      text: `Made from the record at ${ukDateTime(pack.generatedAt)}; printed at ${ukDateTime(print.printedAt)}.`,
    },
  ];
  const missing = pack.sections.filter((s) => s.critical && s.status === "not_recorded");
  const attention = pack.attention ?? [];
  // A photo the pack held as printable but that could not be read or drawn now.
  const photoFailed = photoHeld && !photoPrinted && !missing.some((s) => s.key === "photo");
  if (missing.length > 0) {
    lines.push({
      text: "NOT RECORDED: safety-critical information missing from the record",
      bold: true,
      size: 12,
      gapBefore: 10,
    });
    for (const s of missing) {
      lines.push({ text: NOT_RECORDED_WORDING[s.key] ?? `${s.title}: not recorded`, bold: true });
    }
  }
  if (attention.length > 0 || photoFailed) {
    lines.push({ text: "CHECK BEFORE RELYING ON THIS PACK", bold: true, size: 12, gapBefore: 10 });
    for (const a of attention) {
      const title = pack.sections.find((s) => s.key === a.key)?.title ?? a.key;
      lines.push({
        text: `${title}: ${a.message}${a.onDate ? ` (${ukDate(a.onDate)})` : ""}`,
        bold: true,
      });
    }
    if (photoFailed) {
      lines.push({
        text: "Photo: the photo could not be printed. Confirm the person's identity another way.",
        bold: true,
      });
    }
  }
  if (unprintable.length > 0) {
    lines.push({
      text: `Some characters could not be printed and show as "?" in: ${unprintable.join("; ")}. Check the record.`,
      bold: true,
      gapBefore: 10,
    });
  }
  if (missing.length === 0 && attention.length === 0 && !photoFailed && unprintable.length === 0) {
    lines.push({ text: "Every safety-critical section is recorded.", bold: true, gapBefore: 10 });
  }
  for (const section of body) {
    lines.push(section.heading);
    for (const text of section.lines) lines.push({ text });
  }
  return renderPdf({
    title: "Hospital transfer pack",
    lines,
    image: print.photo,
    footer: (page, pages) =>
      `${name} - born ${ukDate(id.dateOfBirth)} - NHS ${nhs} - made ${ukDateTime(pack.generatedAt)} - page ${page} of ${pages}`,
  });
}

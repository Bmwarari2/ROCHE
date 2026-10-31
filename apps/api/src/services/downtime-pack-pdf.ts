import {
  ADRT_HELD_NOTE,
  ADRT_ONLY_NOTE,
  type AllergyStatement,
  type CommunicationStatement,
  type DowntimeCarePlanLine,
  type DowntimeContact,
  type DowntimeMedicinesContent,
  type DowntimePersonPage,
  type DowntimeResuscitationRecord,
  type DowntimeRisk,
  type DowntimeWarning,
  type EvacuationPlanStatement,
} from "@harbour/domain";
import { type PdfLine, renderPdf } from "./pdf";
import { ukDate, ukDateTime } from "./transfer-pack-pdf";

/**
 * The printed downtime pack (operations.md rules 1 to 7; HZ-001, HZ-015, HZ-016, HZ-021), drawn
 * with the pack PDF writer (ADR-0040) when it is asked for: the header worked out at that moment
 * is on every page, a front sheet lists every warning with the safety-critical ones first, and
 * each person starts a new page whose footer names them. Nothing is stored: the PDF is never a
 * `document` (#32 review round 1, M3). Photos are not printed: every person's page says to confirm
 * who they are with a colleague who knows them, and the front sheet says photos are not printed
 * (#46 review round 1, HZ-001). An ADRT held is printed beside the CPR decision (HZ-015).
 */

/** Until photos print (H-211), every page asks for the person to be identified (HZ-001). */
const IDENTIFY = "Confirm who the person is with a colleague who knows them.";

/** A pack as stored: the domain's `DowntimePack` with its times as ISO strings. */
interface StoredContent {
  readonly locationName: string;
  readonly pages: readonly Json<DowntimePersonPage>[];
  readonly warnings: readonly DowntimeWarning[];
}

/**
 * Said once on the front sheet, first among the safety-critical warnings, while the paper MAR and
 * PEEP places are unconfirmed: it is the page the nurse in charge reads first in an outage (H-213,
 * HZ-021). Each person's page still says "where it is kept is not set in Harbour".
 */
export const PLACES_NOT_CONFIRMED =
  "Where the paper MAR and the PEEPs are kept is not confirmed in Harbour: ask the nurse in charge before you need them.";
type Json<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? readonly Json<U>[]
    : T extends object
      ? { readonly [K in keyof T]: Json<T[K]> }
      : T;

const CPR: Record<string, string> = {
  attempt_cpr: "For cardiopulmonary resuscitation",
  do_not_attempt_cpr: "Not for cardiopulmonary resuscitation",
};

const NHS = (n: string | null) =>
  n ? `NHS number ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}` : "NHS number not recorded";

function allergyLines(a: Json<AllergyStatement>): string[] {
  if (a.status === "has_allergies")
    return a.allergies.map(
      (x) => `${x.substance}${x.reaction ? `: ${x.reaction}` : ""} (severity ${x.severity})`,
    );
  if (a.status === "no_known_allergies")
    return [`No known allergies${a.recordedAt ? ` (recorded ${ukDateTime(a.recordedAt)})` : ""}`];
  return [];
}

const resuscitationLine = (r: Json<DowntimeResuscitationRecord>) =>
  `${r.kind === "respect" ? "ReSPECT" : "DNACPR"}: ${CPR[r.decision] ?? r.decision}. ${
    [r.clinicianName, r.clinicianRole].filter(Boolean).join(", ") || "Clinician not recorded"
  }. Completed ${ukDate(r.completedOn)}${r.reviewDueOn ? `, review due ${ukDate(r.reviewDueOn)}` : ""}${
    r.reviewOverdue ? " (past its review date: it still applies until changed)" : ""
  }.`;

function communicationLines(c: Json<CommunicationStatement>): string[] {
  if (c.status === "recorded")
    return c.needs.map((n) => `${n.display}${n.preferredFormat ? ` (${n.preferredFormat})` : ""}`);
  if (c.status === "none_identified") return ["None identified"];
  return [];
}

function evacuationLines(e: Json<EvacuationPlanStatement> | null): string[] {
  if (!e || e.status === "held_elsewhere") return [];
  return [
    e.summary,
    ...(e.equipment.length > 0 ? [`Equipment: ${e.equipment.join(", ")}`] : []),
    ...(e.staffNeeded !== null ? [`Staff needed: ${e.staffNeeded}`] : []),
  ];
}

function medicinesLines(m: Json<DowntimeMedicinesContent> | null): string[] {
  if (!m || m.status === "held_elsewhere") return [];
  return [
    ...m.due.map(
      (d) =>
        `${ukDateTime(d.dueAt)}: ${d.name} ${d.dose} ${d.route}${d.timeCritical ? " (time-critical)" : ""}`,
    ),
    ...m.prn.map(
      (p) =>
        `When required: ${p.name} ${p.dose} ${p.route}; last given ${p.lastGivenAt ? ukDateTime(p.lastGivenAt) : "not recorded"}`,
    ),
  ];
}

const contactLine = (c: Json<DowntimeContact>) =>
  `${c.name} (${[c.relationship, c.role.replaceAll("_", " ")].filter(Boolean).join(", ")}): ${c.phone ?? "no telephone number recorded"}`;

const planLine = (l: Json<DowntimeCarePlanLine>) =>
  `${l.label}: ${l.need}${l.contingency ? ` If this happens: ${l.contingency}` : ""}`;

const riskLine = (r: Json<DowntimeRisk>) =>
  `${r.title}: ${r.hazard}. Controls: ${r.controls || "none recorded"}${r.reviewDueOn ? `. Review due ${ukDate(r.reviewDueOn)}` : ""}`;

function sectionContent(key: string, page: Json<DowntimePersonPage>): string[] {
  const c = page.content;
  switch (key) {
    case "identity":
      return c.photo
        ? [`Photo held in Harbour (taken ${ukDate(c.photo.takenOn)}); not printed in this pack.`]
        : [];
    case "allergies":
      return allergyLines(c.allergies);
    case "resuscitation":
      return c.resuscitation.map(resuscitationLine);
    case "iddsi_food":
      return c.eatingAndDrinking.food ? [c.eatingAndDrinking.food] : [];
    case "iddsi_drink":
      return [
        ...(c.eatingAndDrinking.drink ? [c.eatingAndDrinking.drink] : []),
        ...(c.eatingAndDrinking.notes ? [c.eatingAndDrinking.notes] : []),
      ];
    case "communication":
      return communicationLines(c.communication);
    case "evacuation":
      return evacuationLines(c.evacuation);
    case "medicines_due":
      return medicinesLines(c.medicinesDue);
    case "contacts":
      return c.contacts.map(contactLine);
    case "care_plan":
      return c.carePlan.map(planLine);
    case "risks":
      return c.risks.map(riskLine);
    default:
      return [];
  }
}

/** The printed name, with "Sample" beside an invented sample person's (HZ-072); older packs lack it. */
function printedName(page: Json<DowntimePersonPage>): string {
  return page.sample === true ? `${page.displayName} (Sample)` : page.displayName;
}

function personLines(page: Json<DowntimePersonPage>): PdfLine[] {
  const name = printedName(page);
  const owner = `${name}, ${page.dateOfBirth ? `born ${ukDate(page.dateOfBirth)}` : "date of birth not recorded"}, ${NHS(page.nhsNumber)}`;
  const lines: PdfLine[] = [
    { text: name, bold: true, size: 13, pageBreakBefore: true, owner },
    ...(page.sample === true
      ? [
          {
            text: "Sample: an invented person for practice. Not a real person or a real record.",
            bold: true,
          },
        ]
      : []),
    {
      text: [
        page.roomLabel ? `Room ${page.roomLabel}` : "No room recorded",
        page.dateOfBirth ? `Born ${ukDate(page.dateOfBirth)}` : "Date of birth not recorded",
        NHS(page.nhsNumber),
      ].join(". "),
    },
  ];
  if (page.away) lines.push({ text: page.away, bold: true });
  for (const section of page.sections) {
    lines.push({ text: section.title, bold: true, gapBefore: 6 });
    if (section.note) lines.push({ text: section.note, bold: section.critical });
    for (const text of sectionContent(section.key, page)) lines.push({ text });
    if (section.key === "identity" && !section.note?.includes(IDENTIFY)) {
      lines.push({ text: IDENTIFY, bold: true });
    }
    if (
      section.key === "resuscitation" &&
      page.content.adrtHeld &&
      section.note !== ADRT_ONLY_NOTE
    ) {
      lines.push({ text: ADRT_HELD_NOTE, bold: true });
    }
    if (section.asOf) lines.push({ text: `As recorded ${ukDateTime(section.asOf)}.`, size: 8 });
  }
  return lines;
}

export function renderDowntimePackPdf(
  content: StoredContent,
  header: readonly string[],
  /**
   * Whether the location's paper MAR and PEEP places are confirmed (`downtime_places_confirmed_at`
   * set). A change to the places builds the pack again, so the pages agree with it unless that
   * build failed, which the header then says. Unconfirmed when not given (H-213).
   */
  options: { readonly placesConfirmed: boolean } = { placesConfirmed: false },
): Uint8Array {
  const names = new Map(content.pages.map((p) => [p.personId, printedName(p)]));
  const placesWarning = !options.placesConfirmed;
  const front: PdfLine[] = [
    { text: `Downtime pack: ${content.locationName}`, bold: true, size: 14 },
    {
      text: `${content.pages.length} ${content.pages.length === 1 ? "person" : "people"} receiving care, in room order.`,
    },
    {
      text: "Photos are not printed in this pack: confirm who each person is with a colleague who knows them.",
      bold: true,
    },
    {
      text:
        content.warnings.length === 0 && !placesWarning
          ? "No warnings."
          : "Check these first (safety-critical first):",
      bold: true,
      gapBefore: 8,
    },
    ...(placesWarning ? [{ text: PLACES_NOT_CONFIRMED, bold: true }] : []),
    ...content.warnings.map((w) => ({
      text: `${names.get(w.personId) ?? "Someone on this pack"}: ${w.message}`,
    })),
  ];
  return renderPdf({
    title: `Downtime pack: ${content.locationName}`,
    header,
    lines: [...front, ...content.pages.flatMap(personLines)],
    footer: (n, total, owner) =>
      `${owner ? `${owner}. ` : ""}Downtime pack, ${content.locationName}. Page ${n} of ${total}.`,
  });
}

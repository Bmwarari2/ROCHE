import type { BackEntryInput, EntryBackEntry, OutageItem } from "@harbour/contracts";
import { MIN_BACK_ENTRY_REASON_LENGTH } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { datePartName } from "@harbour/ui";
import { isUuid } from "./context-cookies";
import { formatDateTime } from "./format";
import type { FieldProblem } from "./outcome";
import { type FormLike, readDateTimeField, readWhen } from "./uk-time";

/**
 * Entering a paper record from an outage on the care record forms (operations.md rules 11 to 13
 * and section 14; hazards HZ-009, HZ-017). Pure and unit tested. The form's "When" offers a third
 * choice, "From a paper downtime form", only while the location has an outage a paper record can
 * still be entered against (open or closed, never reconciled or cancelled). The time is the one
 * written on the form, in UK time, with nothing filled in; the outage is chosen every time; a
 * time outside the chosen outage needs a reason. The API checks every rule again.
 */

/** The form fields a paper record adds, for each form's error summary links. */
export const PAPER_FIELDS = [
  "outageId",
  "paperReference",
  "outsideOutageReason",
  "notFromPaperReason",
] as const;

/** The fields a back-entry adds to a care write (`entryDowntimeInput`). */
export interface EntryDowntime {
  readonly backEntry?: BackEntryInput;
  readonly notFromPaperReason?: string;
}

/**
 * After `outage_reconciled` the server has kept the record for the nurse in charge's review
 * (H-216): the form starts again with a new id, so it cannot be saved a second time as "Now".
 */
export function keptForReview(result: { readonly ok: boolean; readonly code?: string }): boolean {
  return !result.ok && result.code === "outage_reconciled";
}

/** "16/10/2026 09:15": the date and time written on a paper record. */
export function paperWritten(entry: Pick<EntryBackEntry, "paperDate" | "paperTime">): string {
  const [year, month, day] = entry.paperDate.split("-");
  return `${day}/${month}/${year} ${entry.paperTime}`;
}

/** Whether a recent outage here is reconciled or cancelled and none takes paper records now. */
export function paperClosedOff(outages: readonly OutageItem[]): boolean {
  return outages.length > 0 && paperOutages(outages).length === 0;
}

/** Outages a paper record can still be entered against, newest first. */
export function paperOutages(outages: readonly OutageItem[]): OutageItem[] {
  return outages.filter((o) => o.state === "declared" || o.state === "closed");
}

const value = (form: FormLike, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

const pad = (text: string, length = 2) => text.padStart(length, "0");

/** Whether an instant is inside the outage's window `[start, end)`; an open outage runs on. */
export function insideOutage(
  outage: Pick<OutageItem, "startedAt" | "endedAt">,
  instant: string,
): boolean {
  const at = Date.parse(instant);
  return (
    at >= Date.parse(outage.startedAt) &&
    (outage.endedAt === null || at < Date.parse(outage.endedAt))
  );
}

export type EntryWhen =
  | { readonly ok: true; readonly instant: string; readonly downtime: EntryDowntime }
  | { readonly ok: false; readonly problems: readonly FieldProblem[] };

/**
 * When an entry happened, and its back-entry details: "Now" and "Earlier" as before (with the
 * reason it is not from paper when the API has asked for one), or the paper record's outage,
 * date and time as written, reference and outside-the-outage reason. `name` is the WhenField's.
 */
export function readEntryWhen(
  form: FormLike,
  name: string,
  t: Translator,
  outages: readonly OutageItem[],
  options: { readonly now?: Date; readonly subject?: string } = {},
): EntryWhen {
  const now = options.now ?? new Date();
  if (value(form, `${name}-mode`) !== "paper") {
    const when = readWhen(form, name, t, {
      now,
      ...(options.subject ? { subject: options.subject } : {}),
    });
    if (!when.ok) {
      return { ok: false, problems: [{ field: name, message: when.message, parts: when.parts }] };
    }
    const reason = value(form, "notFromPaperReason");
    return {
      ok: true,
      instant: when.instant,
      downtime: reason ? { notFromPaperReason: reason.slice(0, 500) } : {},
    };
  }
  const problems: FieldProblem[] = [];
  const outage = paperOutages(outages).find((o) => o.id === value(form, "outageId"));
  if (!outage) problems.push({ field: "outageId", message: t("care.paper.outageRequired") });
  const read = readDateTimeField(form, name, { subject: t("care.paper.subject"), t, now });
  if (!read.ok) problems.push({ field: name, message: read.message, parts: read.parts });
  const reference = value(form, "paperReference");
  if (reference.length > 80) {
    problems.push({ field: "paperReference", message: t("care.paper.referenceTooLong") });
  }
  const reason = value(form, "outsideOutageReason");
  const instant = read.ok ? read.instant : null;
  const outside = outage !== undefined && instant !== null && !insideOutage(outage, instant);
  if (outside && reason.length < MIN_BACK_ENTRY_REASON_LENGTH) {
    problems.push({
      field: "outsideOutageReason",
      message: t("care.paper.outsideReasonRequired", {
        min: MIN_BACK_ENTRY_REASON_LENGTH,
        from: formatDateTime(outage.startedAt) ?? "",
        to: formatDateTime(outage.endedAt) ?? "none",
      }),
    });
  }
  if (problems.length > 0 || !outage || instant === null) return { ok: false, problems };
  const part = (p: "day" | "month" | "year" | "hour" | "minute") =>
    value(form, datePartName(name, p));
  const fold = value(form, datePartName(name, "fold"));
  return {
    ok: true,
    instant,
    downtime: {
      backEntry: {
        outageId: outage.id,
        paperDate: `${pad(part("year"), 4)}-${pad(part("month"))}-${pad(part("day"))}`,
        paperTime: `${pad(part("hour"))}:${pad(part("minute"))}`,
        ...(fold === "first" ? { occurrence: "earlier" as const } : {}),
        ...(fold === "second" ? { occurrence: "later" as const } : {}),
        ...(reference ? { paperReference: reference } : {}),
        ...(outside ? { outsideOutageReason: reason.slice(0, 500) } : {}),
      },
    },
  };
}

/**
 * A correction of a paper record whose time is now outside its outage (H-207) is refused until
 * it says why (H-208): the paper details sent again, as written, with the reason.
 */
export function correctionBackEntry(
  original: EntryBackEntry,
  outsideOutageReason: string,
): BackEntryInput {
  return {
    outageId: original.outageId,
    paperDate: original.paperDate,
    paperTime: original.paperTime,
    ...(original.occurrence !== "only" ? { occurrence: original.occurrence } : {}),
    ...(original.paperReference ? { paperReference: original.paperReference } : {}),
    outsideOutageReason: outsideOutageReason.trim().slice(0, 500),
  };
}

/**
 * Only the back-entry fields, so nothing else a client sends reaches the API body; null when the
 * outage named is not an id, so the write is refused rather than sent as an ordinary entry.
 */
export function downtimeBody(downtime: EntryDowntime | undefined): EntryDowntime | null {
  if (!downtime) return {};
  const reason = downtime.notFromPaperReason?.trim();
  if (downtime.backEntry) {
    const b = downtime.backEntry;
    if (!isUuid(b.outageId)) return null;
    return {
      backEntry: {
        outageId: b.outageId,
        paperDate: b.paperDate,
        paperTime: b.paperTime,
        ...(b.occurrence ? { occurrence: b.occurrence } : {}),
        ...(b.outsideOutageReason ? { outsideOutageReason: b.outsideOutageReason } : {}),
        ...(b.paperReference ? { paperReference: b.paperReference } : {}),
      },
    };
  }
  return reason ? { notFromPaperReason: reason } : {};
}

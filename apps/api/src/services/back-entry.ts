import type { BackEntryInput, EntryBackEntry, EntryNotFromPaper } from "@harbour/contracts";
import {
  activityRecord,
  bodyMapMark,
  careNote,
  observation,
  outage,
  type Transaction,
  visitLog,
} from "@harbour/db";
import {
  BACK_ENTRY_MESSAGES,
  type BackEntryProblem,
  backEntryLabel,
  type CareRates,
  checkBackEntry,
  checkEntryAgainstOutages,
  formatUkDateTime,
  MIN_BACK_ENTRY_REASON_LENGTH,
  type OutageKind,
  resolvePaperTime,
} from "@harbour/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HttpProblem } from "../http/problem";
import { type OutageRow, outagesAt, outageWindow } from "./outages";

/**
 * Back-entry through the care write routes (operations.md rules 11 to 13; HZ-017, HZ-006), for
 * the five entries a device or the web writes. The routes call `entryDowntime` before they insert
 * and store the columns it returns; the database checks the same rules again
 * (`app.entry_outage_guard`, migration 0053), and `downtimeRefusal` puts its refusals in words.
 *
 * - A back-entry (`backEntry`): the paper time is resolved in UK time (`resolvePaperTime`) and
 *   checked against its outage (`checkBackEntry`); the entry's `occurredAt` must be that instant.
 *   An outage already reconciled takes no new paper records (H-204).
 * - A correction of a back-entry stays a back-entry of the same outage, its paper details carried
 *   when none are sent. It is refused when the paper record has been corrected already (one
 *   current version per paper record; the device's refusal goes to the refused-entry review,
 *   HZ-006), and asks for an outside-the-outage reason when its time is now outside the outage's
 *   window, for example after closing set the true end before it (#38 review round 2; H-208).
 * - Any other entry goes through the normal route (`checkEntryAgainstOutages`, rule 13): written
 *   later for a time inside an outage, it must be a back-entry or say why it is not from paper.
 */

export type DowntimeTable =
  | "care_note"
  | "observation"
  | "body_map_mark"
  | "activity_record"
  | "visit_log";

const TABLES = {
  care_note: careNote,
  observation,
  body_map_mark: bodyMapMark,
  activity_record: activityRecord,
  visit_log: visitLog,
} as const;

/** The back-entry columns of migration 0053, as an insert takes them. */
export interface DowntimeColumns {
  readonly lateEntryReason: "downtime" | null;
  readonly outageId: string | null;
  readonly paperDate: string | null;
  readonly paperTime: string | null;
  readonly paperOccurrence: "only" | "earlier" | "later" | null;
  readonly outsideOutageReason: string | null;
  readonly paperReference: string | null;
  readonly notFromPaperReason: string | null;
}

export const NO_DOWNTIME: DowntimeColumns = {
  lateEntryReason: null,
  outageId: null,
  paperDate: null,
  paperTime: null,
  paperOccurrence: null,
  outsideOutageReason: null,
  paperReference: null,
  notFromPaperReason: null,
};

/** Said when a back-entry is sent for an outage already reconciled (H-204, H-216). */
export const OUTAGE_RECONCILED_BACK_ENTRY =
  "This outage has been reconciled, so this paper record cannot be added to it. Give the paper form to the Registered Manager.";
/** Said once the server has kept that paper record for the nurse in charge's review (H-216). */
export const OUTAGE_RECONCILED_KEPT =
  "This outage has been reconciled, so this paper record cannot be added to it. It has been kept for the nurse in charge to review: give the paper form to the Registered Manager.";
/** Said when an entry not from paper is sent for a time inside a reconciled outage. */
export const OUTAGE_RECONCILED_ENTRY =
  "This time falls in an outage that has been reconciled, so this cannot be added to it. Give the details to the Registered Manager.";
const OUTAGE_RECONCILED_ENTRY_KEPT =
  "This time falls in an outage that has been reconciled, so this cannot be added to it. It has been kept for the nurse in charge to review.";
const STAYS_PAPER = "A correction of a paper record stays a paper record of the same outage.";
const STAYS_ORDINARY =
  "A correction of an entry not entered from paper cannot make it a paper record.";
const TIME_IS_PAPER_TIME = "Use the time written on the paper form as the time of this entry.";
const NOT_PAPER_REASON = "A paper record does not need a reason it was not written on paper.";

/**
 * A refusal whose entry the server keeps with the person's refused-entry review
 * (`withLateEntryReview`; HZ-006, HZ-017), saying so in `keptDetail` once kept. `fromWebToo`: kept
 * from the web as well as from a device.
 */
export class BackEntryForReview extends HttpProblem {
  constructor(
    status: 409 | 422,
    code: string,
    title: string,
    detail: string,
    readonly personId: string,
    readonly keptDetail: string,
    readonly fromWebToo: boolean,
  ) {
    super(status, code, title, detail);
    this.name = "BackEntryForReview";
  }
}

/** The words for a device whose refused correction is now with the nurse in charge. */
export const ALREADY_CORRECTED_REVIEW =
  "This correction was not saved because the paper record has been corrected already. The nurse in charge has a task to review it.";

/**
 * A second correction of the same paper record (the database keeps one current version of each;
 * #38 review round 2). From a device, the entry is kept for review; the web reloads and corrects
 * the current version.
 */
export function alreadyCorrected(personId: string): BackEntryForReview {
  return new BackEntryForReview(
    409,
    "back_entry_already_corrected",
    "This paper record has been corrected already.",
    "Reload it and correct the current version.",
    personId,
    ALREADY_CORRECTED_REVIEW,
    false,
  );
}

/** A record for an outage already reconciled, kept for review from every route (H-204, H-216). */
function reconciledRefusal(personId: string, fromPaper: boolean): BackEntryForReview {
  return new BackEntryForReview(
    422,
    "outage_reconciled",
    "Some details need checking.",
    fromPaper ? OUTAGE_RECONCILED_BACK_ENTRY : OUTAGE_RECONCILED_ENTRY,
    personId,
    fromPaper ? OUTAGE_RECONCILED_KEPT : OUTAGE_RECONCILED_ENTRY_KEPT,
    true,
  );
}

const reasonOf = (text: string | undefined | null) =>
  text && text.trim().length >= MIN_BACK_ENTRY_REASON_LENGTH ? text.trim() : null;

function refuse(code: string, detail: string): never {
  throw new HttpProblem(422, code, "Some details need checking.", detail);
}

function refuseProblems(found: readonly BackEntryProblem[]): never {
  refuse("back_entry_refused", [...new Set(found)].map((p) => BACK_ENTRY_MESSAGES[p]).join(" "));
}

/** The window the database uses: `[start, end)`, an open outage running to now plus the drift. */
function inWindow(row: OutageRow, at: Date, now: Date, clockDriftMinutes: number): boolean {
  const end = row.endedAt ?? new Date(now.getTime() + clockDriftMinutes * 60_000);
  return at.getTime() >= row.startedAt.getTime() && at.getTime() < end.getTime();
}

/** H-208: a corrected paper record's time outside its outage's window, asking why. */
function outsideWords(row: OutageRow, at: Date): string {
  return at.getTime() < row.startedAt.getTime()
    ? `This paper record's time is before the outage started at ${formatUkDateTime(row.startedAt)}. Say why it was written on paper then.`
    : `This paper record's time is after the outage ended at ${formatUkDateTime(row.endedAt ?? at)}. Say why, for example 'Form dated after the power came back'.`;
}

export interface DowntimeContext {
  readonly personId: string;
  /** The entry's location (the person's). */
  readonly locationId: string;
  /** The entry's stored event time (`occurred_at`). */
  readonly occurredAt: Date;
  /** When it was written: the device time, or the server's for the web. */
  readonly recordedAt: Date;
  readonly now: Date;
  readonly rates: Pick<CareRates, "lateEntryHours" | "clockDriftMinutes">;
}

export interface DowntimeBody {
  readonly backEntry?: BackEntryInput | undefined;
  readonly notFromPaperReason?: string | undefined;
  readonly supersedesId?: string | undefined;
}

/** The back-entry columns for an entry about to be written, or the refusal in words. */
export async function entryDowntime(
  tx: Transaction,
  table: DowntimeTable,
  body: DowntimeBody,
  ctx: DowntimeContext,
): Promise<DowntimeColumns> {
  const t = TABLES[table];
  const [original] = body.supersedesId
    ? await tx
        .select({
          lateEntryReason: t.lateEntryReason,
          outageId: t.outageId,
          occurredAt: t.occurredAt,
          paperDate: t.paperDate,
          paperTime: t.paperTime,
          paperOccurrence: t.paperOccurrence,
          paperReference: t.paperReference,
          outsideOutageReason: t.outsideOutageReason,
          notFromPaperReason: t.notFromPaperReason,
        })
        .from(t)
        .where(eq(t.id, body.supersedesId))
    : [];
  if (original?.lateEntryReason === "downtime" && body.supersedesId) {
    if (body.notFromPaperReason) refuse("back_entry_refused", STAYS_PAPER);
    if (body.backEntry && body.backEntry.outageId !== original.outageId) {
      refuse("back_entry_refused", STAYS_PAPER);
    }
    // One current version per paper record: two corrections at once are taken in turn.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`back_entry_correction:${body.supersedesId}`}))`,
    );
    const [corrected] = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.supersedesId, body.supersedesId), eq(t.lateEntryReason, "downtime")))
      .limit(1);
    if (corrected) throw alreadyCorrected(ctx.personId);
    const [row] = original.outageId
      ? await tx.select().from(outage).where(eq(outage.id, original.outageId))
      : [];
    if (!row) refuseProblems(["unknown_outage"]);
    const columns = body.backEntry
      ? paperColumns(body.backEntry, row, ctx)
      : {
          ...NO_DOWNTIME,
          lateEntryReason: "downtime" as const,
          outageId: row.id,
          paperDate: original.paperDate,
          paperTime: original.paperTime,
          paperOccurrence: original.paperOccurrence as DowntimeColumns["paperOccurrence"],
          paperReference: original.paperReference,
          outsideOutageReason: original.outsideOutageReason,
          at: original.occurredAt,
        };
    const { at, ...stored } = columns;
    if (at.getTime() !== ctx.occurredAt.getTime()) refuse("back_entry_refused", TIME_IS_PAPER_TIME);
    if (!stored.outsideOutageReason && !inWindow(row, at, ctx.now, ctx.rates.clockDriftMinutes)) {
      refuse("outside_outage_reason_required", outsideWords(row, at));
    }
    return stored;
  }
  if (body.backEntry) {
    if (original) refuse("back_entry_refused", STAYS_ORDINARY);
    if (body.notFromPaperReason) refuse("back_entry_refused", NOT_PAPER_REASON);
    const rows = await outagesAt(tx, ctx.locationId);
    const row = rows.find((o) => o.id === body.backEntry?.outageId);
    if (!row) refuseProblems(["unknown_outage"]);
    if (row.state === "reconciled") throw reconciledRefusal(ctx.personId, true);
    const { at, ...stored } = paperColumns(body.backEntry, row, ctx);
    if (at.getTime() !== ctx.occurredAt.getTime()) refuse("back_entry_refused", TIME_IS_PAPER_TIME);
    if (!stored.outsideOutageReason && !inWindow(row, at, ctx.now, ctx.rates.clockDriftMinutes)) {
      refuseProblems(["outside_outage_window"]);
    }
    return stored;
  }
  // A correction of an entry not from paper keeps its reason unless it gives another; one that
  // keeps the entry's time corrects a record already judged, so is not asked again (rule 13).
  return normalRoute(
    tx,
    { notFromPaperReason: body.notFromPaperReason ?? original?.notFromPaperReason ?? undefined },
    ctx,
    original ? { outageId: original.outageId, sameTime: sameTime(original.occurredAt, ctx) } : null,
  );
}

const sameTime = (at: Date, ctx: DowntimeContext) => at.getTime() === ctx.occurredAt.getTime();

/** A back-entry's columns from what the form says (`resolvePaperTime`, `checkBackEntry`). */
function paperColumns(
  given: BackEntryInput,
  row: OutageRow,
  ctx: DowntimeContext,
): DowntimeColumns & { readonly at: Date } {
  const paperTime = resolvePaperTime(
    { date: given.paperDate, time: given.paperTime },
    {
      now: ctx.now,
      clockDriftMinutes: ctx.rates.clockDriftMinutes,
      ...(given.occurrence ? { occurrence: given.occurrence } : {}),
    },
  );
  const check = checkBackEntry(
    {
      personId: ctx.personId,
      locationId: ctx.locationId,
      paperTime,
      recordedAt: ctx.recordedAt,
      receivedAt: ctx.now,
      outageId: row.id,
      reason: given.outsideOutageReason ?? null,
      paperReference: given.paperReference ?? null,
    },
    [outageWindow(row)],
    ctx.rates,
  );
  // A time outside the outage with no reason is left to the caller, which words it.
  if (!check.ok && check.problems.some((p) => p !== "outside_outage_window")) {
    refuseProblems(check.problems);
  }
  if (!paperTime.ok) refuseProblems(["paper_time_invalid"]);
  const at = paperTime.instant;
  const reason = reasonOf(given.outsideOutageReason);
  // The database's window leaves the end itself outside: a time exactly at the end says why too.
  const inside = inWindow(row, at, ctx.now, ctx.rates.clockDriftMinutes);
  return {
    lateEntryReason: "downtime",
    outageId: row.id,
    paperDate: given.paperDate,
    paperTime: given.paperTime,
    paperOccurrence: paperTime.occurrence,
    outsideOutageReason: inside ? null : reason,
    paperReference: given.paperReference?.trim() || null,
    notFromPaperReason: null,
    at,
  };
}

/**
 * Rule 13 (HZ-017): an entry written later for a time inside a declared outage must say why it is
 * not from paper, and then names the outage. Written at the time, it is ordinary.
 */
async function normalRoute(
  tx: Transaction,
  body: DowntimeBody,
  ctx: DowntimeContext,
  corrected: { readonly outageId: string | null; readonly sameTime: boolean } | null,
): Promise<DowntimeColumns> {
  const rows = await outagesAt(tx, ctx.locationId);
  const check = checkEntryAgainstOutages(
    {
      locationId: ctx.locationId,
      eventAt: ctx.occurredAt,
      recordedAt: ctx.recordedAt,
      hasBackEntryDetails: false,
      notFromPaperReason: body.notFromPaperReason ?? null,
    },
    rows.map(outageWindow),
    ctx.rates,
  );
  if (!check.ok && !corrected?.sameTime) refuse("back_entry_details_required", check.message);
  const reason = reasonOf(body.notFromPaperReason);
  const row = rows.find((o) => o.id === check.outageId);
  // Outside every outage (or exactly at an end, outside the database's window), nothing is kept.
  if (!row || !reason || !inWindow(row, ctx.occurredAt, ctx.now, ctx.rates.clockDriftMinutes)) {
    return NO_DOWNTIME;
  }
  if (row.state === "reconciled" && corrected?.outageId !== row.id) {
    throw reconciledRefusal(ctx.personId, false);
  }
  return { ...NO_DOWNTIME, outageId: row.id, notFromPaperReason: reason };
}

/** What a care write's audit event says about it (rule 12: audited with the outage id). */
export function downtimeAudit(columns: DowntimeColumns): Record<string, unknown> {
  if (columns.lateEntryReason === "downtime") {
    return { outageId: columns.outageId, backEntry: true };
  }
  return columns.outageId ? { outageId: columns.outageId, notFromPaper: true } : {};
}

const GUARD_WORDS: readonly (readonly [string, string])[] = [
  [
    "An entry names an outage",
    "That outage cannot take this entry: choose an outage at the person's location that is neither cancelled nor reconciled.",
  ],
  ["A correction of a paper record", STAYS_PAPER],
  ["A correction of an entry not entered from paper", STAYS_ORDINARY],
  ["A paper record's time", TIME_IS_PAPER_TIME],
  ["An entry not written on paper", "This time is not inside that outage."],
  ["A paper record with a time outside", BACK_ENTRY_MESSAGES.outside_outage_window],
];

/**
 * The database's refusal of a back-entry in words (422), or null when the error is not one: the
 * guard's refusals, the back-entry CHECK, and the one-correction index.
 */
export function downtimeRefusal(error: unknown, personId: string): HttpProblem | null {
  const e = error as {
    code?: string;
    message?: string;
    constraint?: string;
    cause?: { code?: string; message?: string; constraint?: string };
  };
  const pg = e.code ? e : (e.cause ?? {});
  const message = pg.message ?? "";
  if (pg.code === "23503" || pg.code === "23000") {
    const words = GUARD_WORDS.find(([start]) => message.startsWith(start));
    if (words)
      return new HttpProblem(422, "back_entry_refused", "Some details need checking.", words[1]);
  }
  if (pg.code === "23514" && (pg.constraint ?? message).includes("_back_entry")) {
    return new HttpProblem(
      422,
      "back_entry_refused",
      "Some details need checking.",
      "A paper record needs its outage, the date and time written on the form and which time it was in the hour the clocks go back; any other entry has none of these.",
    );
  }
  // Two corrections of one paper record at the same moment: the index keeps one (as above).
  if (pg.code === "23505" && (pg.constraint ?? message).includes("_back_entry_correction_key")) {
    return alreadyCorrected(personId);
  }
  return null;
}

/** Rethrows a care insert's error, in words when the database refused a back-entry. */
export function onDowntimeError(personId: string): (error: unknown) => never {
  return (error) => {
    throw downtimeRefusal(error, personId) ?? error;
  };
}

/** The outages the entries name, for their labels (read in the reader's view). */
export async function entryOutages(
  tx: Transaction,
  rows: readonly { outageId?: string | null }[],
): Promise<ReadonlyMap<string, OutageRow>> {
  const ids = [...new Set(rows.flatMap((r) => (r.outageId ? [r.outageId] : [])))];
  if (ids.length === 0) return new Map();
  const found = await tx.select().from(outage).where(inArray(outage.id, ids));
  return new Map(found.map((o) => [o.id, o]));
}

/**
 * The words shown with a back-entry (rule 12; HZ-017), from its outage; when the reader cannot see
 * the outage, from the paper time and the entry's own times, so it never reads as contemporaneous.
 */
export function paperLabel(
  row: {
    occurredAt: Date;
    recordedAt: Date;
    deviceTime: Date | null;
    outsideOutageReason: string | null;
  },
  found: Pick<OutageRow, "kind" | "startedAt" | "endedAt"> | null,
): string {
  const recordedAt = row.deviceTime ?? row.recordedAt;
  if (!found) {
    return `Written on paper ${formatUkDateTime(row.occurredAt)} during an outage. Entered in Harbour ${formatUkDateTime(recordedAt)} on the device, received ${formatUkDateTime(row.recordedAt)}.`;
  }
  return backEntryLabel({
    eventAt: row.occurredAt,
    recordedAt,
    receivedAt: row.recordedAt,
    outage: { kind: found.kind as OutageKind, startedAt: found.startedAt },
    withinOutage:
      row.occurredAt.getTime() >= found.startedAt.getTime() &&
      (found.endedAt === null || row.occurredAt.getTime() < found.endedAt.getTime()),
    outsideReason: row.outsideOutageReason,
  });
}

/**
 * What alerts and tasks raised from a back-entered entry say (rule 12; HZ-017): its label and the
 * time written on the paper. Undefined for any other entry.
 */
export async function paperSource(
  tx: Transaction,
  row: Parameters<typeof downtimeOut>[0],
): Promise<{ label: string; paperAt: Date } | undefined> {
  if (row.lateEntryReason !== "downtime") return undefined;
  const label = downtimeOut(row, await entryOutages(tx, [row])).backEntry?.label;
  return label ? { label, paperAt: row.occurredAt } : undefined;
}

/** An entry's back-entry output, with its label (rule 12; HZ-017). */
export function downtimeOut(
  row: {
    occurredAt: Date;
    recordedAt: Date;
    deviceTime: Date | null;
    lateEntryReason: string | null;
    outageId: string | null;
    paperDate: string | null;
    paperTime: string | null;
    paperOccurrence: string | null;
    outsideOutageReason: string | null;
    paperReference: string | null;
    notFromPaperReason: string | null;
  },
  outages: ReadonlyMap<string, OutageRow>,
): { backEntry: EntryBackEntry | null; notFromPaper: EntryNotFromPaper | null } {
  if (row.lateEntryReason === "downtime" && row.outageId && row.paperDate && row.paperTime) {
    const found = outages.get(row.outageId);
    return {
      backEntry: {
        outageId: row.outageId,
        paperDate: row.paperDate,
        paperTime: row.paperTime.slice(0, 5),
        occurrence: (row.paperOccurrence ?? "only") as EntryBackEntry["occurrence"],
        outsideOutageReason: row.outsideOutageReason,
        paperReference: row.paperReference,
        label: paperLabel(row, found ?? null),
      },
      notFromPaper: null,
    };
  }
  return {
    backEntry: null,
    notFromPaper:
      row.outageId && row.notFromPaperReason
        ? { outageId: row.outageId, reason: row.notFromPaperReason }
        : null,
  };
}

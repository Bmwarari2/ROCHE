import {
  ClientIdHeaders,
  type DeviceDeletionFlag,
  HandoverHeaders,
  IDEMPOTENCY_KEY_HEADER,
  type SyncRefusedEntry,
} from "@harbour/contracts";
import type { Transaction } from "@harbour/db";
import type { CareTrigger, PersonRecordKind } from "@harbour/domain";
import { z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx } from "../http/audit";
import {
  type AppEnv,
  permissionsReaching,
  requirePermission,
  type TenantAccess,
  withTenant,
} from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { BackEntryForReview, entryOutages } from "../services/back-entry";
import { applyTaskLink, type PlannedTaskLink, planTaskLink } from "../services/care";
import { deletionFlags, type FlaggedEntryTable } from "../services/device-holds";
import { refuseRevokedDevice } from "../services/devices";
import {
  type HandedOverAdmission,
  type HeldHandover,
  handedOverByOf,
  heldHandoverOf,
} from "../services/held-handover";
import type { OutageRow } from "../services/outages";
import { CareEventAfterExit, loadPerson, raiseLateEntryReview } from "../services/people";
import { copyRefusedEntry, refusedCopyQuota } from "../services/refused-entries";
import { NO_STAFF, type StaffLookup, staffNames } from "../services/staff";

/**
 * Helpers shared by the point-of-care routes (care.ts, care-plans.ts and care-records.ts): the
 * person path parameter, reading windows, the output of append-only entries and corrections.
 */

export const PersonParam = z.object({ id: z.uuid() });
export const SENT_AT_HEADER = "x-harbour-sent-at";
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client id of a create (care.md section 5, client ids; HZ-029): the body's `id`, or the
 * `Idempotency-Key` header when the body has none. When both are sent they must be the same id,
 * so a retry can never record under two ids.
 */
export function clientIdOf(c: Context<AppEnv>, bodyId: string | undefined): string | undefined {
  const header = c.req.header(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!header) return bodyId?.toLowerCase();
  if (!UUID.test(header)) {
    throw problems.invalid("Send the record's client id (a UUID) as the Idempotency-Key.");
  }
  const key = header.toLowerCase();
  if (bodyId && bodyId.toLowerCase() !== key) {
    throw problems.invalid("The Idempotency-Key and the record's id differ. Send one id.");
  }
  return key;
}

/** The headers a care entry upload may carry: a hand-over's, and the client id. */
export const EntryHeaders = HandoverHeaders.extend(ClientIdHeaders.shape);

/** The body with its client id from `clientIdOf`. */
export function withClientId<B extends { id?: string | undefined }>(
  c: Context<AppEnv>,
  body: B,
): B {
  const id = clientIdOf(c, body.id);
  return id === undefined ? body : { ...body, id };
}

/**
 * Takes a transaction lock on a client id before a create looks for an earlier copy, so two sends
 * of the same save are taken in turn: the second finds the first's record and returns it (HZ-029).
 */
export async function lockClientId(tx: Transaction, kind: string, id: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`client_id:${kind}:${id}`}))`);
}

/**
 * An insert whose client id another record already has (one the caller cannot see, or of another
 * kind) is refused in words, never as a server error: an id is never reused.
 */
export function refuseUsedId(error: unknown): never {
  const code =
    (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code === "23505") throw problems.invalid("That id is already used.");
  throw error;
}

/** The id of a replayed create must belong to the same person: an id is never reused. */
export function sameRecordOrRefuse<R extends { personId: string }>(row: R, personId: string): R {
  if (row.personId !== personId) throw problems.invalid("That id is already used.");
  return row;
}

/** Said when a save sent again with its client id carries different details (409). */
export const REPLAY_CHANGED =
  "This was already saved with different details: reload before changing it.";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/** A value as it compares across a request and a stored row: dates by instant, text trimmed. */
function comparable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return null;
    if (ISO_DATE.test(text)) {
      const at = Date.parse(text);
      if (!Number.isNaN(at)) return at;
    }
    return text;
  }
  if (Array.isArray(value)) return JSON.stringify(value.map(comparable));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, comparable(v)]);
    return JSON.stringify(entries);
  }
  return value;
}

/**
 * A save sent again with its client id must carry the details the record holds (HZ-029; #26
 * review round 2, C5): a form keeps its id until a save is confirmed, so a reply lost on the way
 * back and a change made before sending again would otherwise return the old record as if the
 * new one were saved. Every field given is compared with the stored record (missing and empty
 * read as nothing; dates by instant); any difference is refused with 409
 * `already_saved_differently` (its own code since round 3, so a screen never says someone else
 * changed the record), and nothing is saved.
 */
export function requireSameDetails(
  stored: Readonly<Record<string, unknown>>,
  sent: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(sent)) {
    if (comparable(value) !== comparable(stored[key])) {
      throw problems.alreadySavedDifferently(REPLAY_CHANGED);
    }
  }
}

export const range = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

/** A reading window: the last three days by default, never more than 92 days. */
export function window(q: { from?: string; to?: string }, now: Date) {
  const from = q.from ? new Date(q.from) : new Date(now.getTime() - 3 * DAY_MS);
  const to = q.to ? new Date(q.to) : new Date(now.getTime() + DAY_MS);
  if (to.getTime() - from.getTime() > 92 * DAY_MS)
    throw problems.invalid("Ask for 92 days or fewer.");
  return { from, to };
}

export const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * What an entry's output needs besides its row: its staff's names (care.md section 5, staff
 * names) and the server's flag when its device recorded deleting it (section 6, Device integrity
 * part 3).
 */
export interface EntryExtras {
  readonly staff: StaffLookup;
  readonly deletion: ReadonlyMap<string, DeviceDeletionFlag>;
  /** The outages back-entries name, for their labels (operations.md rule 12). */
  readonly outages: ReadonlyMap<string, OutageRow>;
}

export const NO_EXTRAS: EntryExtras = { staff: NO_STAFF, deletion: new Map(), outages: new Map() };

/**
 * Reads the extras for the entries of one table a response returns, in the reader's transaction.
 * The flag is read by table and id, the key it is stored under.
 */
export async function entryExtras(
  tx: Transaction,
  table: FlaggedEntryTable,
  rows: readonly {
    id: string;
    createdBy: string | null;
    handedOverBy?: string | null;
    outageId?: string | null;
  }[],
): Promise<EntryExtras> {
  if (rows.length === 0) return NO_EXTRAS;
  const staff = await staffNames(
    tx,
    rows.flatMap((r) => [r.createdBy, r.handedOverBy ?? null]),
  );
  return {
    staff,
    deletion: await deletionFlags(
      tx,
      table,
      rows.map((r) => r.id),
    ),
    outages: await entryOutages(tx, rows),
  };
}

export function entryOut(
  row: {
    id: string;
    personId: string;
    locationId: string;
    occurredAt: Date;
    recordedAt: Date;
    deviceTime: Date | null;
    lateEntry: boolean;
    clockDrift: boolean;
    recordedAfterExit: boolean;
    taskId: string | null;
    taskOutcome: string | null;
    supersedesId: string | null;
    correctionReason: string | null;
    createdBy: string | null;
    /** Only the five tables a device writes have it. */
    handedOverBy?: string | null;
  },
  superseded: ReadonlySet<string>,
  extras: EntryExtras,
) {
  return {
    id: row.id,
    personId: row.personId,
    locationId: row.locationId,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    deviceTime: iso(row.deviceTime),
    lateEntry: row.lateEntry,
    clockDrift: row.clockDrift,
    recordedAfterExit: row.recordedAfterExit,
    taskId: row.taskId,
    taskOutcome: row.taskOutcome as PlannedTaskLink["outcome"] | null,
    supersedesId: row.supersedesId,
    correctionReason: row.correctionReason,
    superseded: superseded.has(row.id),
    recordedBy: row.createdBy,
    recordedByStaff: extras.staff(row.createdBy),
    handedOverBy: row.handedOverBy ?? null,
    handedOverByStaff: extras.staff(row.handedOverBy),
    deviceDeletion: extras.deletion.get(row.id) ?? null,
  };
}

export function supersededIds(rows: readonly { supersedesId: string | null }[]): Set<string> {
  return new Set(rows.flatMap((r) => (r.supersedesId ? [r.supersedesId] : [])));
}

/** A correction must point at an entry about the same person, and say why. */
export function requireCorrection(body: { supersedesId?: string; correctionReason?: string }) {
  if (body.supersedesId && !body.correctionReason) {
    throw problems.invalid("Say why the entry is being corrected.");
  }
}

/** Who writes a care entry a device uploads, and for whom. */
export interface EntryWriter {
  readonly access: TenantAccess;
  /** Who wrote the entry: the caller, or the owner of handed-over entries (`created_by`). */
  readonly author: string;
  /** The hand-over the entry arrives by, when it does (care.md section 6, Device integrity). */
  readonly handover: HeldHandover | null;
  /** Who sent the entry for its author ("Sent by", `handed_over_by`): a manager's hand-over. */
  readonly handedOverBy: string | null;
}

/**
 * The access for a care entry a device uploads (notes, observations, body-map marks, activities and
 * visits): the route's permission; a hand-over of held entries checked (part 6; each entry is then
 * planned with `planHandedOverEntry` and admitted in its transaction); otherwise a device a manager revoked refused with 403
 * `device_revoked`, audited (part 2). A hand-over is how a revoked device's entries leave it, so it
 * is not refused here: only entries recorded before the revocation are admitted.
 */
export async function entryWriteAccess(
  c: Context<AppEnv>,
  kind: "care_note" | "observation" | "body_map_mark" | "activity_record" | "visit_log",
): Promise<EntryWriter> {
  const access = await requirePermission(c, "care.note.write");
  const handover = await heldHandoverOf(c, access);
  if (!handover) {
    await refuseRevokedDevice(c.get("services"), access, `care.${kind}`, c.get("requestId"));
  }
  return {
    access,
    author: handover?.ownerTenantUserId ?? access.tenantUserId,
    handover,
    handedOverBy: handedOverByOf(handover),
  };
}

/**
 * What an entry will do to the task it names (`planTaskLink`), or null when it names none. The
 * author's permission is judged when the care was recorded (`occurredAt`; HZ-004, HZ-006), and
 * only where it reaches the person (ADR-0071).
 */
export async function planLink(
  tx: Transaction,
  access: TenantAccess,
  taskId: string | undefined,
  personId: string,
  occurredAt: Date,
  author: string = access.tenantUserId,
): Promise<PlannedTaskLink | null> {
  if (!taskId) return null;
  // A handed-over entry is judged on its author's permission when the care was recorded, never on
  // the manager's who sent it (care.md section 6, Device integrity part 6).
  const handedOver = author !== access.tenantUserId;
  return planTaskLink(tx, {
    taskId,
    personId,
    actorTenantUserId: author,
    actorPermissions: handedOver
      ? new Set<string>()
      : // The task link is not given the session's freshness: a permission needing a fresh
        // sign-in counts only while it is fresh (review round 2).
        await permissionsReaching(tx, access, personId, { freshOnly: true }),
    occurredAt,
    stepUpFresh:
      handedOver ||
      Date.now() - access.session.sessionCreatedAt.getTime() <= access.stepUpWindowSeconds * 1000,
  });
}

/**
 * Carries out a planned link once this request has inserted the entry (`applyTaskLink`). An
 * assignee who may not complete the task has the completion refused and audited with the entry,
 * which is kept, flagged and reviewed (S1 follow-on; HZ-004, HZ-006); a duplicate upload that lost
 * the race to insert writes nothing, so no refusal is recorded for an entry it did not create.
 */
export async function applyLink(
  tx: Transaction,
  access: TenantAccess,
  requestId: string | undefined,
  link: PlannedTaskLink,
  entry: Parameters<typeof applyTaskLink>[2],
): Promise<void> {
  await applyTaskLink(tx, link, entry);
  if (link.assigneeRefused) {
    await auditInTx(tx, access, {
      action: "platform.task.done",
      outcome: "denied",
      resourceType: "task",
      resourceId: link.taskId,
      reason: "assignee_lacks_permission",
      requestId,
    });
  }
}

/**
 * The kind of a care event for people.md rule 3: once a person has left or died, an entry about an
 * event at or before then is a care event (accepted and flagged as recorded after the exit), and
 * a note about anything later is a post-event note.
 */
export function eventKind(
  person: {
    status: string;
    statusChangedAt: Date;
    dischargedAt: Date | null;
    deceasedAt: Date | null;
  },
  kind: "care_note" | "observation" | "body_map_mark" | "assessment",
  occurredAt: Date,
): PersonRecordKind {
  if (kind !== "care_note" || (person.status !== "discharged" && person.status !== "deceased")) {
    return kind;
  }
  const exit =
    person.status === "deceased"
      ? (person.deceasedAt ?? person.statusChangedAt)
      : (person.dischargedAt ?? person.statusChangedAt);
  return occurredAt.getTime() > exit.getTime() ? "post_event_note" : "care_note";
}

/** Rule 12: a closed record takes post-event records only. */
export function requireOpenRecord(person: { closed: boolean }) {
  if (person.closed) {
    throw problems.invalid("This person's record is closed; only post-event notes can be added.");
  }
}

/** The refused entry as the late-entry review names it: opaque references, no clinical text. */
export interface RefusedEntry {
  /** The kind of entry (`care_note`, `observation`, `incident` and so on). */
  readonly kind: string;
  /** The device-generated id the entry was sent with, if any. */
  readonly clientId?: string | null | undefined;
  /** When the entry says the event happened. */
  readonly occurredAt?: string | null | undefined;
  /** Who wrote it, when not the caller (a handed-over entry's owner). */
  readonly recordedBy?: string | undefined;
  /** The request as sent, kept on the server when a back-entry is refused for review. */
  readonly payload?: unknown;
  /** A hand-over's plan for the entry, admitted with the copy instead (Device integrity part 6). */
  readonly admission?: HandedOverAdmission | null | undefined;
}

/**
 * Runs a care write. A care event timed after the person left, died or went away (beyond the
 * clock tolerance) is refused, so the device keeps it to resolve, and one review task goes to the
 * nurse in charge in its own transaction, so it is not lost with the refusal. The task names the
 * entry's kind, client id, device and user (people.md rule 3; HZ-006).
 */
export async function withLateEntryReview<T>(
  c: Context<AppEnv>,
  entry: RefusedEntry,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof BackEntryForReview) {
      throw await keepForReview(c, entry, error);
    }
    if (error instanceof CareEventAfterExit) {
      const access = c.get("access");
      await withTenant(c, async (tx) => {
        const p = await loadPerson(tx, error.personId);
        const taskId = await raiseLateEntryReview(tx, p, new Date(), {
          kind: entry.kind,
          clientId: entry.clientId ?? null,
          occurredAt: entry.occurredAt ?? null,
          deviceId: access.deviceId,
          recordedBy: entry.recordedBy ?? access.tenantUserId,
        });
        await auditInTx(tx, access, {
          action: "care.entry.after_exit",
          outcome: "denied",
          resourceType: "person",
          resourceId: p.id,
          reason: "occurred_after_status_change",
          scope: { reviewTaskId: taskId },
          requestId: c.get("requestId"),
        });
      });
    }
    throw error;
  }
}

/**
 * A back-entry refused for review (operations.md section 14; HZ-006, HZ-017): a device's second
 * correction of the same paper record, or a paper record (or an entry not from paper) for an
 * outage already reconciled. The server keeps the entry as sent with the person's refused-entry
 * review task for the nurse in charge (`copyRefusedEntry`, with a hand-over's admission), so its
 * content is never lost or only on one phone, and the refusal says so. A second correction from
 * the web is not kept: the form corrects the current version. A copy that cannot be kept leaves
 * the refusal as it was (the device sends it again), logged by opaque ids.
 */
async function keepForReview(
  c: Context<AppEnv>,
  entry: RefusedEntry,
  error: BackEntryForReview,
): Promise<HttpProblem> {
  const access = c.get("access");
  if (entry.payload === undefined) return error;
  if (!error.fromWebToo && (!access.deviceId || !entry.clientId)) return error;
  try {
    await copyRefusedEntry(
      c.get("services").db,
      access,
      {
        table: entry.kind,
        entryId: entry.clientId ?? crypto.randomUUID(),
        personId: error.personId,
        httpStatus: error.status,
        code: error.code,
        message: error.keptDetail,
        refusedAt: new Date().toISOString(),
        payload: entry.payload,
      } as SyncRefusedEntry,
      {
        author: entry.recordedBy ?? access.tenantUserId,
        deviceId: access.deviceId,
        now: new Date(),
        requestId: c.get("requestId"),
        admission: entry.admission ?? null,
        quota: refusedCopyQuota(),
      },
    );
  } catch (failure) {
    c.get("services").logger.warn(
      {
        requestId: c.get("requestId"),
        personId: error.personId,
        entryId: entry.clientId ?? null,
        code: error.code,
        failure: failure instanceof HttpProblem ? failure.code : "error",
      },
      "refused back-entry not kept for review",
    );
    return error;
  }
  return new HttpProblem(error.status, error.code, error.title, error.keptDetail);
}

/** Follow-ups that stay relevant whoever is left to act: the incident and safeguarding prompts. */
const SAFETY_TASKS = new Set(["incident_report", "safeguarding_decision_guide"]);

/**
 * The follow-ups an entry recorded after a status change still raises (people.md rule 3): before
 * a move to hospital or on leave, the urgent alert to the nurse in charge (the result may matter
 * to the hospital) and the safety prompts; after a discharge or death, the safety prompts only.
 * Point-of-care follow-ups (repeat observations, rescreens) are not raised for someone not here.
 */
export function triggersAfterChange(
  triggers: readonly CareTrigger[],
  recordedAfterExit: boolean,
  status: string,
): CareTrigger[] {
  if (!recordedAfterExit) return [...triggers];
  const away = status === "on_leave" || status === "in_hospital";
  return triggers.filter(
    (t) => (t.kind === "urgent_alert" && away) || (t.kind === "task" && SAFETY_TASKS.has(t.task)),
  );
}

/**
 * The member's lone-working session on the phone (scheduling.md sections 17 and 18; SCHED-012,
 * HZ-125), worked out from what the API last said (`GET /v1/lone-worker/sessions/mine`, which shows
 * a duress press as a check-in) and what the phone has queued, so the screen only draws. Pure apart
 * from the translator.
 *
 * Never shown, anywhere: that duress was pressed. A queued duress press reads exactly as a queued
 * check-in (`screenKind`), and the screen offers it only as a second way to check in, with the same
 * words, the same answer and the same feedback.
 *
 * Help can only reach someone through Harbour. Offline, a help press waits on the phone, and the
 * screen says so in words, with "If you are in danger, call 999", never that help is on its way.
 */
import { parseInstant, ukDateTimeParts } from "../care/time";
import { type MessageKey, t } from "../i18n/t";

export type LoneWorkerEventKind = "check_in" | "help" | "duress" | "finish";

/** What `GET /v1/lone-worker/sessions/mine` answers, as the phone keeps it. */
export interface MineSession {
  readonly id: string;
  readonly locationId: string;
  readonly workKind: string;
  readonly startedAt: string;
  readonly plannedEndAt: string;
  readonly intervalMinutes: number;
  readonly finishedAt: string | null;
  readonly status: string;
  readonly nextDueAt: string | null;
  readonly overdueAlarmOpen: boolean;
  readonly events: readonly {
    readonly id: string;
    readonly kind: string;
    readonly deviceAt: string;
    readonly late: boolean;
  }[];
}

export interface Mine {
  readonly on: boolean;
  readonly session: MineSession | null;
}

/** A lone-worker action queued on the phone (`lone_worker_outbox`), not yet sent. */
export interface QueuedAction {
  readonly id: string;
  readonly action: "start" | "event";
  readonly sessionId: string;
  readonly body: Record<string, unknown>;
}

export interface EventLine {
  readonly id: string;
  /** "Checked in at 10:02", the same for a duress press. */
  readonly words: string;
  readonly waiting: boolean;
}

/** A lone-working action the API refused, as kept under "needs attention" (duress as a check-in). */
export interface RefusedAction {
  readonly action: "start" | "event";
  readonly sessionId: string;
  readonly kind: string;
}

/** What the help line says: nothing, waiting, being sent, refused, or with Harbour. */
export type HelpState = "none" | "waiting" | "sending" | "refused" | "received";

export interface LoneWorkerView {
  readonly kind: "off" | "none" | "session";
  readonly sessionId: string | null;
  /** "Next check-in due at 10:30", "Check-in overdue since 10:30", or null. */
  readonly due: string | null;
  readonly overdue: boolean;
  /** "Session until 16:00". */
  readonly until: string | null;
  readonly lines: readonly EventLine[];
  /** Actions waiting to send: shown in words with the count. */
  readonly waiting: number;
  /** A help press is waiting on the phone: say it has not reached anyone. */
  readonly helpWaiting: boolean;
  /** A help press the API refused: it reached nobody (HZ-125). */
  readonly helpRefused: boolean;
  /** Harbour has a help request in this session. */
  readonly helpReceived: boolean;
  /** The session is known only on this phone: nobody is told if a check-in is missed. */
  readonly unconfirmed: boolean;
  /** A start the API refused: lone working did not begin. */
  readonly startRefused: boolean;
  readonly finished: boolean;
}

/** What the help line should say, from the view, the connection and whether help was just pressed. */
export function helpState(view: LoneWorkerView, connected: boolean, pressed: boolean): HelpState {
  if (view.helpRefused) return "refused";
  if (view.helpWaiting) return connected ? "sending" : "waiting";
  if (view.helpReceived) return "received";
  return pressed ? "sending" : "none";
}

/** What the screen shows for an event: a duress press is a check-in (HZ-125). */
export function screenKind(kind: string): LoneWorkerEventKind {
  if (kind === "duress") return "check_in";
  if (kind === "help" || kind === "finish") return kind;
  return "check_in";
}

const EVENT_WORDS: Record<LoneWorkerEventKind, MessageKey> = {
  check_in: "mobile.lone.event.check_in",
  help: "mobile.lone.event.help",
  duress: "mobile.lone.event.check_in",
  finish: "mobile.lone.event.finish",
};

function timeOf(value: string | null | undefined): string | null {
  const at = parseInstant(value);
  return at ? ukDateTimeParts(at).time : null;
}

function lineFor(id: string, kind: string, at: string, waiting: boolean): EventLine {
  return {
    id,
    words: t(EVENT_WORDS[screenKind(kind)], { time: timeOf(at) ?? "" }),
    waiting,
  };
}

/**
 * The next check-in due, offline too: one interval after the latest sign of the worker (a
 * check-in, help or duress, by device time) or the start, never later than the planned end
 * (section 17.3 rule 3). The server decides; this is what the worker is told to aim for.
 */
export function nextDue(
  startedAt: string,
  plannedEndAt: string,
  intervalMinutes: number,
  signsAt: readonly string[],
): Date | null {
  const start = parseInstant(startedAt);
  const end = parseInstant(plannedEndAt);
  if (!start || !end || !(intervalMinutes > 0)) return null;
  let latest = start.getTime();
  for (const s of signsAt) {
    const at = parseInstant(s)?.getTime();
    if (at !== undefined && at > latest) latest = at;
  }
  return new Date(Math.min(latest + intervalMinutes * 60_000, end.getTime()));
}

export function loneWorkerView(
  mine: Mine | null,
  queued: readonly QueuedAction[],
  now: Date,
  refusals: readonly RefusedAction[] = [],
) {
  const helpRefused = refusals.some((r) => r.action === "event" && r.kind === "help");
  const startRefused = refusals.some((r) => r.action === "start");
  const start = queued.find((q) => q.action === "start");
  const server = mine?.session && !mine.session.finishedAt ? mine.session : null;
  // A session started offline is the phone's until the server has it.
  const sessionId = server?.id ?? (start ? start.sessionId : null);
  const off = mine !== null && !mine.on && !start;
  if (!sessionId) {
    return {
      kind: off ? "off" : "none",
      sessionId: null,
      due: null,
      overdue: false,
      until: null,
      lines: [],
      waiting: queued.length,
      helpWaiting: queued.some((q) => q.body.kind === "help"),
      helpRefused,
      helpReceived: false,
      unconfirmed: false,
      startRefused,
      finished: false,
    } satisfies LoneWorkerView;
  }
  const mineEvents = server?.events ?? [];
  const pending = queued.filter((q) => q.action === "event" && q.sessionId === sessionId);
  const lines: EventLine[] = [
    ...mineEvents.map((e) => lineFor(e.id, e.kind, e.deviceAt, false)),
    ...pending.map((q) =>
      lineFor(String(q.body.id), String(q.body.kind), String(q.body.deviceAt), true),
    ),
  ].reverse();
  const startedAt = server?.startedAt ?? String(start?.body.startedAt ?? "");
  const plannedEndAt = server?.plannedEndAt ?? String(start?.body.plannedEndAt ?? "");
  const interval = server?.intervalMinutes ?? Number(start?.body.intervalMinutes ?? 0);
  const signs = [
    ...mineEvents.filter((e) => e.kind !== "finish").map((e) => e.deviceAt),
    ...pending.filter((q) => q.body.kind !== "finish").map((q) => String(q.body.deviceAt)),
  ];
  const finished = pending.some((q) => q.body.kind === "finish");
  // With nothing of the worker's still to send, the server's own due time stands: a monitor's
  // "safe confirmed" moves it (section 17.3 rule 6).
  const pendingSigns = pending.some((q) => q.body.kind !== "finish");
  const serverDue = server && !pendingSigns ? parseInstant(server.nextDueAt) : null;
  const due = finished ? null : (serverDue ?? nextDue(startedAt, plannedEndAt, interval, signs));
  const overdue =
    (due !== null && due.getTime() < now.getTime()) || server?.overdueAlarmOpen === true;
  const dueTime = due ? ukDateTimeParts(due).time : null;
  return {
    kind: "session",
    sessionId,
    due: dueTime
      ? t(overdue ? "mobile.lone.overdue" : "mobile.lone.nextDue", { time: dueTime })
      : null,
    overdue,
    until: timeOf(plannedEndAt)
      ? t("mobile.lone.until", { time: timeOf(plannedEndAt) ?? "" })
      : null,
    lines,
    waiting: queued.length,
    helpWaiting: queued.some((q) => q.body.kind === "help"),
    helpRefused,
    helpReceived: mineEvents.some((e) => e.kind === "help"),
    unconfirmed: server === null,
    startRefused,
    finished,
  } satisfies LoneWorkerView;
}

/**
 * The lone-worker actions still on the phone, read from PowerSync's upload queue (`ps_crud`):
 * `lone_worker_outbox` is insert-only, so a queued action lives nowhere else. Anything unreadable
 * is left out here and refused, in words, by the upload (`shift-upload.ts`).
 */
export function queuedActions(
  rows: readonly { readonly data: string | null }[],
  /** Only the signed-in organisation's actions count. */
  tenantId: string,
): QueuedAction[] {
  const out: QueuedAction[] = [];
  for (const row of rows) {
    let entry: unknown;
    try {
      entry = row.data ? JSON.parse(row.data) : null;
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "lone_worker_outbox" || e.op !== "PUT" || typeof e.id !== "string") continue;
    const data = (typeof e.data === "object" && e.data !== null ? e.data : {}) as Record<
      string,
      unknown
    >;
    if (data.tenant_id !== tenantId) continue;
    const action = data.action;
    const sessionId = data.session_id;
    if ((action !== "start" && action !== "event") || typeof sessionId !== "string") continue;
    let body: unknown;
    try {
      body = typeof data.body === "string" ? JSON.parse(data.body) : null;
    } catch {
      continue;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
    out.push({ id: e.id, action, sessionId, body: body as Record<string, unknown> });
  }
  return out;
}

/** Reads `GET /v1/lone-worker/sessions/mine`, or null when the answer is not one. */
export function parseMine(body: unknown): Mine | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.on !== "boolean") return null;
  if (b.session === null) return { on: b.on, session: null };
  const s = b.session as Record<string, unknown> | undefined;
  if (
    !s ||
    typeof s.id !== "string" ||
    typeof s.startedAt !== "string" ||
    typeof s.plannedEndAt !== "string" ||
    typeof s.intervalMinutes !== "number" ||
    !Array.isArray(s.events)
  ) {
    return null;
  }
  return {
    on: b.on,
    session: {
      id: s.id,
      locationId: String(s.locationId ?? ""),
      workKind: String(s.workKind ?? "other"),
      startedAt: s.startedAt,
      plannedEndAt: s.plannedEndAt,
      intervalMinutes: s.intervalMinutes,
      finishedAt: typeof s.finishedAt === "string" ? s.finishedAt : null,
      status: String(s.status ?? ""),
      nextDueAt: typeof s.nextDueAt === "string" ? s.nextDueAt : null,
      overdueAlarmOpen: s.overdueAlarmOpen === true,
      events: (s.events as unknown[]).flatMap((e) => {
        if (typeof e !== "object" || e === null) return [];
        const ev = e as Record<string, unknown>;
        if (typeof ev.id !== "string" || typeof ev.deviceAt !== "string") return [];
        // The API already shows duress as a check-in; the phone makes sure of it (HZ-125).
        return [
          {
            id: ev.id,
            kind: screenKind(String(ev.kind ?? "")),
            deviceAt: ev.deviceAt,
            late: ev.late === true,
          },
        ];
      }),
    },
  };
}

/** Refused lone-working actions from "needs attention" (`upload_issue` payloads). */
export function refusedActions(
  rows: readonly { readonly payload: string | null }[],
): RefusedAction[] {
  const out: RefusedAction[] = [];
  for (const row of rows) {
    let p: unknown;
    try {
      p = row.payload ? JSON.parse(row.payload) : null;
    } catch {
      continue;
    }
    if (typeof p !== "object" || p === null) continue;
    const data = p as Record<string, unknown>;
    const action = data.action;
    if ((action !== "start" && action !== "event") || typeof data.session_id !== "string") continue;
    let kind = "";
    try {
      const body: unknown = typeof data.body === "string" ? JSON.parse(data.body) : null;
      if (typeof body === "object" && body !== null)
        kind = String((body as { kind?: unknown }).kind ?? "");
    } catch {
      kind = "";
    }
    out.push({ action, sessionId: data.session_id, kind: screenKind(kind) });
  }
  return out;
}

/**
 * The Shifts tab's reads and writes (scheduling.md section 18; SCHED-002, SCHED-004, SCHED-012).
 * Clock events and lone-working actions are written to the phone's own database with a client
 * UUID and sent when there is a connection; the API decides, and a refusal comes back in its words
 * under "needs attention".
 */
import { usePowerSync, useQuery } from "@powersync/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../app-state/session";
import { platformFetch } from "../auth/clients";
import { appEnv } from "../config/app-env";
import { newEntryId } from "../platform/ids";
import { TENANT_HEADER } from "../sync/session-signals";
import {
  clockStatement,
  type LoneWorkKind,
  loneEmergencyStatement,
  loneEventStatement,
  loneStartStatement,
} from "./actions";
import { type ClockEventRow, type ClockKind, clockView, type ShiftRow } from "./clock-view";
import {
  type LoneWorkerEventKind,
  loneWorkerView,
  type Mine,
  parseMine,
  type QueuedAction,
  queuedActions,
  refusedActions,
} from "./lone-worker-view";
import {
  DEMO_QUEUED_LONE_WORKER_SQL,
  MINE_META_PREFIX,
  MY_CLOCK_EVENTS_SQL,
  MY_SHIFTS_SQL,
  QUEUED_LONE_WORKER_SQL,
  READ_META_SQL,
  REFUSED_LONE_WORKER_SQL,
  WRITE_META_SQL,
} from "./queries";

export const TIMESHEET_SELF = "scheduling.timesheet.self";
export const LONE_WORKER_CHECK_IN = "scheduling.lone_worker.check_in";

export type WriteOutcome = "saved" | "no_location" | "not_saved";

/** The time, again each minute, so "under way" and "overdue" move on. */
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The member's only location, when they have exactly one. */
function useOnlyLocation(): string | null {
  const { me } = useSession();
  const locations = me?.locations ?? [];
  return locations.length === 1 ? (locations[0]?.id ?? null) : null;
}

export function useClock(now: Date) {
  const db = usePowerSync();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const workerId = me?.tenantUserId ?? "";
  const only = useOnlyLocation();
  const shiftParams = useMemo(() => [tenantId], [tenantId]);
  const eventParams = useMemo(() => [tenantId, workerId], [tenantId, workerId]);
  const { data: shifts } = useQuery<ShiftRow>(MY_SHIFTS_SQL, shiftParams);
  const { data: events } = useQuery<ClockEventRow>(MY_CLOCK_EVENTS_SQL, eventParams);
  const view = useMemo(() => clockView(shifts, events, now, only), [shifts, events, now, only]);
  const record = useCallback(
    async (kind: ClockKind): Promise<WriteOutcome> => {
      if (!tenantId || !workerId) return "not_saved";
      if (!view.locationId) return "no_location";
      const statement = clockStatement({
        id: newEntryId(),
        tenantId,
        workerId,
        kind,
        shiftId: view.shiftId,
        locationId: view.locationId,
        at: new Date(),
      });
      try {
        await db.execute(statement.sql, statement.params);
        return "saved";
      } catch {
        return "not_saved";
      }
    },
    [db, tenantId, workerId, view.locationId, view.shiftId],
  );
  return { view, record };
}

/** The last answer from `GET /v1/lone-worker/sessions/mine`, asked again when the sync status moves. */
export interface MineAnswer {
  readonly mine: Mine;
  /** When Harbour gave this answer. */
  readonly at: string;
}

/** Reads the kept answer (`MINE_META_PREFIX`), or null when there is none or it cannot be read. */
export function parseKeptMine(value: string | null | undefined): MineAnswer | null {
  if (!value) return null;
  try {
    const kept = JSON.parse(value) as { mine?: unknown; at?: unknown };
    const mine = parseMine(kept.mine);
    return mine && typeof kept.at === "string" ? { mine, at: kept.at } : null;
  } catch {
    return null;
  }
}

/**
 * The API's last answer about the member's own session (`GET /v1/lone-worker/sessions/mine`, which
 * shows duress as a check-in), asked again when the sync status moves and kept in the encrypted
 * device database with when it came, so a restart without a connection still shows the session
 * and how old the answer is (clinical review of slice 71, M3).
 */
function useMine(): { readonly answer: MineAnswer | null; readonly refresh: () => void } {
  const db = usePowerSync();
  const { me, token } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const metaId = `${MINE_META_PREFIX}${tenantId}`;
  const [answer, setAnswer] = useState<MineAnswer | null>(null);
  useEffect(() => {
    if (!tenantId) return;
    db.getOptional<{ value: string | null }>(READ_META_SQL, [metaId])
      .then((row) => {
        const kept = parseKeptMine(row?.value);
        if (kept) setAnswer((current) => current ?? kept);
      })
      .catch(() => undefined);
  }, [db, tenantId, metaId]);
  const refresh = useCallback(() => {
    if (appEnv.demoMode) {
      setAnswer(
        (current) => current ?? { mine: { on: true, session: null }, at: new Date().toISOString() },
      );
      return;
    }
    if (!token || !tenantId) return;
    platformFetch(`${appEnv.apiUrl}/v1/lone-worker/sessions/mine`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        [TENANT_HEADER]: tenantId,
      },
      credentials: "omit",
    })
      .then(async (response) => {
        // Access withdrawn or the session gone: the kept answer no longer holds, so the screen
        // stops showing a session as with Harbour (clinical re-review of slice 71).
        if (response.status === 403 || response.status === 404) {
          setAnswer(null);
          await db.execute("DELETE FROM sync_meta WHERE id = ?", [metaId]);
          return;
        }
        if (!response.ok) return;
        const parsed = parseMine(await response.json());
        if (!parsed) return;
        const next = { mine: parsed, at: new Date().toISOString() };
        setAnswer(next);
        // Kept as parsed: a duress event is already a check-in here (HZ-125).
        await db.execute(WRITE_META_SQL, [metaId, metaId, JSON.stringify(next)]);
      })
      // Offline: keep the last answer; the queued actions say the rest.
      .catch(() => undefined);
  }, [db, token, tenantId, metaId]);
  useEffect(() => {
    refresh();
    return db.registerListener({ statusChanged: refresh });
  }, [db, refresh]);
  return { answer, refresh };
}

function useQueuedLoneWorker(tenantId: string): {
  readonly queued: QueuedAction[];
  readonly reread: () => Promise<void>;
} {
  const db = usePowerSync();
  const [queued, setQueued] = useState<QueuedAction[]>([]);
  const reread = useCallback(
    () =>
      db
        .getAll<{ data: string | null }>(
          appEnv.demoMode ? DEMO_QUEUED_LONE_WORKER_SQL : QUEUED_LONE_WORKER_SQL,
        )
        .then((rows) => setQueued(queuedActions(rows, tenantId)))
        .catch(() => undefined),
    [db, tenantId],
  );
  useEffect(() => {
    void reread();
    return db.registerListener({
      statusChanged: () => {
        void reread();
      },
    });
  }, [db, reread]);
  return { queued, reread };
}

export function useLoneWorker(now: Date) {
  const db = usePowerSync();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const { answer, refresh } = useMine();
  const { queued, reread } = useQueuedLoneWorker(tenantId);
  const refusedParams = useMemo(() => [tenantId], [tenantId]);
  const { data: refusedRows } = useQuery<{ payload: string | null }>(
    REFUSED_LONE_WORKER_SQL,
    refusedParams,
  );
  const refusals = useMemo(() => refusedActions(refusedRows), [refusedRows]);
  const mine = answer?.mine ?? null;
  const [pressedHelp, setPressedHelp] = useState<string[]>([]);
  const view = useMemo(
    () => loneWorkerView(mine, queued, now, refusals, pressedHelp),
    [mine, queued, now, refusals, pressedHelp],
  );
  const write = useCallback(
    async (statement: { sql: string; params: (string | null)[] }): Promise<WriteOutcome> => {
      try {
        await db.execute(statement.sql, statement.params);
      } catch {
        return "not_saved";
      }
      // Read the queue again before answering, so the screen says what is waiting.
      await reread();
      refresh();
      return "saved";
    },
    [db, reread, refresh],
  );
  const start = useCallback(
    (input: {
      readonly locationId: string | null;
      readonly workKind: LoneWorkKind;
      readonly hours: number;
      readonly intervalMinutes: number;
    }): Promise<WriteOutcome> => {
      if (!tenantId) return Promise.resolve("not_saved");
      if (!input.locationId) return Promise.resolve("no_location");
      return write(
        loneStartStatement({
          sessionId: newEntryId(),
          tenantId,
          locationId: input.locationId,
          workKind: input.workKind,
          at: new Date(),
          hours: input.hours,
          intervalMinutes: input.intervalMinutes,
        }),
      );
    },
    [tenantId, write],
  );
  const event = useCallback(
    async (kind: LoneWorkerEventKind): Promise<WriteOutcome> => {
      if (!tenantId) return "not_saved";
      const eventId = newEntryId();
      const at = new Date();
      // Help with no session on the phone still goes, to the emergency route (H-1317).
      const statement = view.sessionId
        ? loneEventStatement({ eventId, sessionId: view.sessionId, tenantId, kind, at })
        : kind === "help"
          ? loneEmergencyStatement({ eventId, tenantId, at })
          : null;
      if (!statement) return "not_saved";
      const outcome = await write(statement);
      if (outcome === "saved" && kind === "help") setPressedHelp((ids) => [...ids, eventId]);
      return outcome;
    },
    [tenantId, view.sessionId, write],
  );
  return { view, answeredAt: answer?.at ?? null, start, event };
}

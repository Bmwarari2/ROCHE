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
} from "./lone-worker-view";
import {
  DEMO_QUEUED_LONE_WORKER_SQL,
  MY_CLOCK_EVENTS_SQL,
  MY_SHIFTS_SQL,
  QUEUED_LONE_WORKER_SQL,
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
function useMine(): { readonly mine: Mine | null; readonly refresh: () => void } {
  const db = usePowerSync();
  const { me, token } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const [mine, setMine] = useState<Mine | null>(null);
  const refresh = useCallback(() => {
    if (appEnv.demoMode) {
      setMine((current) => current ?? { on: true, session: null });
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
        if (!response.ok) return;
        const parsed = parseMine(await response.json());
        if (parsed) setMine(parsed);
      })
      // Offline: keep the last answer; the queued actions say the rest.
      .catch(() => undefined);
  }, [token, tenantId]);
  useEffect(() => {
    refresh();
    return db.registerListener({ statusChanged: refresh });
  }, [db, refresh]);
  return { mine, refresh };
}

function useQueuedLoneWorker(): { readonly queued: QueuedAction[]; readonly reread: () => void } {
  const db = usePowerSync();
  const [queued, setQueued] = useState<QueuedAction[]>([]);
  const reread = useCallback(() => {
    db.getAll<{ data: string | null }>(
      appEnv.demoMode ? DEMO_QUEUED_LONE_WORKER_SQL : QUEUED_LONE_WORKER_SQL,
    )
      .then((rows) => setQueued(queuedActions(rows)))
      .catch(() => undefined);
  }, [db]);
  useEffect(() => {
    reread();
    return db.registerListener({ statusChanged: reread });
  }, [db, reread]);
  return { queued, reread };
}

export function useLoneWorker(now: Date) {
  const db = usePowerSync();
  const { me } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const { mine, refresh } = useMine();
  const { queued, reread } = useQueuedLoneWorker();
  const view = useMemo(() => loneWorkerView(mine, queued, now), [mine, queued, now]);
  const write = useCallback(
    async (statement: { sql: string; params: (string | null)[] }): Promise<WriteOutcome> => {
      try {
        await db.execute(statement.sql, statement.params);
      } catch {
        return "not_saved";
      }
      reread();
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
    (kind: LoneWorkerEventKind): Promise<WriteOutcome> => {
      if (!tenantId || !view.sessionId) return Promise.resolve("not_saved");
      return write(
        loneEventStatement({
          eventId: newEntryId(),
          sessionId: view.sessionId,
          tenantId,
          kind,
          at: new Date(),
        }),
      );
    },
    [tenantId, view.sessionId, write],
  );
  return { view, asked: mine !== null, start, event };
}

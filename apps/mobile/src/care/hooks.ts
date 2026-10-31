/**
 * React hooks shared by the Care mode screens: the signed-in tenant, the context for new entries,
 * the upload queue count, refused uploads, and saving an entry to the encrypted database (from where
 * PowerSync's persistent upload queue sends it, surviving an app restart).
 */
import {
  DEVICE_WRITABLE_TABLES,
  type OfflineWindowTable,
  ROUND_WRITABLE_TABLES,
} from "@harbour/sync/client";
import { usePowerSync, useQuery } from "@powersync/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../app-state/session";
import { useVault } from "../app-state/vault";
import { appEnv } from "../config/app-env";
import { demoWriteScope } from "../demo/demo-data";
import { sha256Base64 } from "../platform/digest";
import { newEntryId } from "../platform/ids";
import { useWriteScope } from "../sync/write-scope-store";
import { type EntryContext, type EntryRow, type FieldError, insertStatement } from "./entries";
import {
  CARE_PROFILE_SQL,
  type CareProfileRow,
  HELD_COUNT_SQL,
  PERSON_CONTEXT_SQL,
  type PersonContextRow,
  ROUND_TASK_FOR_PERSON_SQL,
  UPLOAD_ISSUES_SQL,
  type UploadIssueRow,
} from "./queries";
import {
  acknowledgementInsert,
  checkTaskMove,
  type HandoverToAcknowledge,
  moveRefusal,
  type ShownItem,
  type TaskMoveTo,
  type TaskToMove,
  writeAcknowledgement,
  writeTaskMove,
} from "./round-actions";
import type { WhenChoice } from "./time";

export function useTenantId(): string {
  const { me } = useSession();
  return me?.tenant.id ?? "";
}

/**
 * The person's care profile with whether the query has run, so "not on this device" (C3, C6) is
 * never shown while it is still loading.
 */
export function useCareProfileState(personId: string): {
  readonly profile: CareProfileRow | null;
  readonly loaded: boolean;
} {
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data, isLoading } = useQuery<CareProfileRow>(CARE_PROFILE_SQL, params);
  return { profile: data[0] ?? null, loaded: !isLoading };
}

/**
 * When the care happened, for a form (C4). A correction starts from the original entry's event
 * time, until the carer changes it.
 */
export function useWhenChoice(
  originalAt: string | null | undefined,
): readonly [WhenChoice, (next: WhenChoice) => void] {
  const [when, setWhen] = useState<WhenChoice>({ kind: "now" });
  const touched = useRef(false);
  useEffect(() => {
    if (originalAt && !touched.current) setWhen({ kind: "original", at: originalAt });
  }, [originalAt]);
  const update = useCallback((next: WhenChoice) => {
    touched.current = true;
    setWhen(next);
  }, []);
  return [when, update] as const;
}

/** The person's care profile (IDDSI levels, SpO2 scale), or null when none is on the device. */
export function useCareProfile(personId: string): CareProfileRow | null {
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data } = useQuery<CareProfileRow>(CARE_PROFILE_SQL, params);
  return data[0] ?? null;
}

/**
 * The round task a route asks an entry to answer, checked against this device: synced here, in the
 * tenant, about this person, open and not already marked here. Null otherwise, so neither a link
 * from outside nor a stale route can tag an entry to the wrong round, and its title is the synced
 * one (#123 security review, M2; HZ-004, HZ-029).
 */
export function useRoundTaskFor(
  personId: string,
  taskId: string | null,
): { readonly id: string; readonly title: string | null } | null {
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId, taskId ?? "", personId], [tenantId, taskId, personId]);
  const { data } = useQuery<{ id: string; title: string | null }>(
    ROUND_TASK_FOR_PERSON_SQL,
    params,
  );
  return taskId ? (data[0] ?? null) : null;
}

/**
 * What a new entry for this person needs: tenant, person, location, author and a UUIDv7, and the
 * round's task it answers when the carer came from the round to record it (`taskId`, sent with
 * the entry so the API completes the task; screens gate item (f)).
 */
export function useEntryContext(
  personId: string,
  requestedTaskId: string | null = null,
): EntryContext {
  const tenantId = useTenantId();
  const { me } = useSession();
  // Only a task this device holds, about this person and still open (#123 security review, M2).
  const taskId = useRoundTaskFor(personId, requestedTaskId)?.id ?? null;
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data } = useQuery<PersonContextRow>(PERSON_CONTEXT_SQL, params);
  const locationId = data[0]?.location_id ?? null;
  const userId = me?.user.id ?? null;
  const vault = useVault();
  const windowDays = vault.offlineWindowDays;
  const clockToleranceMinutes = vault.clockToleranceMinutes;
  return useMemo(
    () => ({
      tenantId,
      personId,
      locationId,
      userId,
      windowDays,
      clockToleranceMinutes,
      newId: newEntryId,
      taskId,
    }),
    [tenantId, personId, locationId, userId, windowDays, clockToleranceMinutes, taskId],
  );
}

/** Writes one entry in its own transaction: one entry, one upload. */
export function useSaveEntry(): (table: OfflineWindowTable, row: EntryRow) => Promise<void> {
  const db = usePowerSync();
  return useCallback(
    async (table, row) => {
      const statement = insertStatement(table, row);
      await db.writeTransaction(async (tx) => {
        await tx.execute(statement.sql, statement.params);
      });
    },
    [db],
  );
}

/**
 * Why this member may not act on a round task here, by the same rule as a move (`moveRefusal`),
 * so the evidence path refuses where "Done" would (#123 clinical review, L1); null when they may.
 * The person's home is the synced row's, as the round query reads it.
 */
export function useTaskRefusal(): (
  task: TaskToMove,
  personLocationId: string | null,
) => FieldError | null {
  const { me } = useSession();
  const userId = me?.tenantUserId ?? null;
  const tokenScope = useWriteScope();
  const scope = tokenScope ?? (appEnv.demoMode ? demoWriteScope : null);
  return useCallback(
    (task, personLocationId) => {
      const key = moveRefusal(task, { userId, scope, personLocationId, newId: newEntryId });
      return key ? { key } : null;
    },
    [userId, scope],
  );
}

/**
 * Marks a task done or not done on this device (round-actions.ts): the problem to show, or null
 * once the move is written and waiting to upload. Only where the server would take it, from the
 * member and the write scope (never while either is unknown). The person's home is read here from
 * the synced person row, never taken from the caller, so a row still loading is refused rather
 * than let through (#36 review round 2). A write that fails locally is thrown.
 */
export function useMoveTask(): (
  task: TaskToMove,
  draft: { readonly to: TaskMoveTo; readonly reason: string },
) => Promise<FieldError | null> {
  const db = usePowerSync();
  const { me } = useSession();
  const userId = me?.tenantUserId ?? null;
  const tokenScope = useWriteScope();
  // The demo has no sync token: its member may record about everyone at the demo home.
  const scope = tokenScope ?? (appEnv.demoMode ? demoWriteScope : null);
  return useCallback(
    async (task, draft) => {
      const person = task.person_id
        ? await db.getOptional<{ location_id: string | null }>(
            "SELECT location_id FROM person WHERE tenant_id = ? AND id = ?",
            [task.tenant_id, task.person_id],
          )
        : null;
      const personLocationId = person?.location_id ?? null;
      const check = checkTaskMove(
        task,
        draft,
        { userId, scope, personLocationId, newId: newEntryId },
        new Date(),
      );
      if (!check.ok) return check.error;
      await writeTaskMove(db, check);
      return null;
    },
    [db, userId, scope],
  );
}

/**
 * Acknowledges a handover on this device over the items the reader was shown: the problem to show,
 * or null once written. Never while the member is unknown, and once only while one is waiting.
 */
export function useAcknowledgeHandover(): (
  handover: HandoverToAcknowledge,
  shown: readonly ShownItem[],
) => Promise<FieldError | null> {
  const db = usePowerSync();
  const { me } = useSession();
  const userId = me?.tenantUserId ?? null;
  return useCallback(
    async (handover, shown) => {
      if (!userId) return { key: "mobile.round.userUnknown" };
      const insert = await acknowledgementInsert(
        handover,
        shown,
        { userId, newId: newEntryId, sha256Base64 },
        new Date(),
      );
      const written = await writeAcknowledgement(db, insert);
      return written === "written" ? null : { key: "mobile.handover.alreadyQueued" };
    },
    [db, userId],
  );
}

/** Changes waiting to upload, refreshed whenever the sync status changes. */
export function useQueuedChanges(): number {
  const db = usePowerSync();
  const [queued, setQueued] = useState(0);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      db.getUploadQueueStats()
        .then((stats) => {
          if (active) setQueued(stats.count);
        })
        .catch(() => undefined);
    };
    refresh();
    const dispose = db.registerListener({ statusChanged: refresh });
    // A write made on this device also changes the count before any status change.
    const disposeChange = db.onChange(
      { onChange: refresh },
      { tables: [...DEVICE_WRITABLE_TABLES, ...ROUND_WRITABLE_TABLES], throttleMs: 250 },
    );
    return () => {
      active = false;
      dispose();
      disposeChange();
    };
  }, [db]);
  return queued;
}

/**
 * Entries the server refused, kept on this device (HZ-006), and how many: null when they could not
 * be read, never taken as none (clinical review round 5, C-L7).
 */
export function useUploadIssueState(): {
  readonly rows: readonly UploadIssueRow[];
  readonly count: number | null;
} {
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId], [tenantId]);
  const { data, error } = useQuery<UploadIssueRow>(UPLOAD_ISSUES_SQL, params);
  return { rows: data, count: error ? null : data.length };
}

/** Entries the server refused, kept on this device (HZ-006). */
export function useUploadIssues(): readonly UploadIssueRow[] {
  return useUploadIssueState().rows;
}

/**
 * Entries still held after the owner signed in again (clinical review M2); null when they could not
 * be counted, never read as none (clinical review round 4, M4).
 */
export function useHeldEntryCount(): number | null {
  const { data, error } = useQuery<{ count: number }>(HELD_COUNT_SQL);
  if (error) return null;
  return Number(data[0]?.count ?? 0);
}

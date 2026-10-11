/**
 * React hooks shared by the Care mode screens: the signed-in tenant, the context for new entries,
 * the upload queue count, refused uploads, and saving an entry to the encrypted database (from where
 * PowerSync's persistent upload queue sends it, surviving an app restart).
 */
import { DEVICE_WRITABLE_TABLES, type OfflineWindowTable } from "@harbour/sync/client";
import { usePowerSync, useQuery } from "@powersync/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "../app-state/session";
import { newEntryId } from "../platform/ids";
import { type EntryContext, type EntryRow, insertStatement } from "./entries";
import {
  CARE_PROFILE_SQL,
  type CareProfileRow,
  PERSON_CONTEXT_SQL,
  type PersonContextRow,
  UPLOAD_ISSUES_SQL,
  type UploadIssueRow,
} from "./queries";

export function useTenantId(): string {
  const { me } = useSession();
  return me?.tenant.id ?? "";
}

/** The person's care profile (IDDSI levels, SpO2 scale), or null when none is on the device. */
export function useCareProfile(personId: string): CareProfileRow | null {
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data } = useQuery<CareProfileRow>(CARE_PROFILE_SQL, params);
  return data[0] ?? null;
}

/** What a new entry for this person needs: tenant, person, location, author and a UUIDv7. */
export function useEntryContext(personId: string): EntryContext {
  const tenantId = useTenantId();
  const { me } = useSession();
  const params = useMemo(() => [tenantId, personId], [tenantId, personId]);
  const { data } = useQuery<PersonContextRow>(PERSON_CONTEXT_SQL, params);
  const locationId = data[0]?.location_id ?? null;
  const userId = me?.user.id ?? null;
  return useMemo(
    () => ({ tenantId, personId, locationId, userId, newId: newEntryId }),
    [tenantId, personId, locationId, userId],
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
      { tables: [...DEVICE_WRITABLE_TABLES], throttleMs: 250 },
    );
    return () => {
      active = false;
      dispose();
      disposeChange();
    };
  }, [db]);
  return queued;
}

/** Entries the server refused, kept on this device (HZ-006). */
export function useUploadIssues(): readonly UploadIssueRow[] {
  const tenantId = useTenantId();
  const params = useMemo(() => [tenantId], [tenantId]);
  const { data } = useQuery<UploadIssueRow>(UPLOAD_ISSUES_SQL, params);
  return data;
}

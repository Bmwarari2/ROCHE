import { usePowerSync, useQuery, useStatus } from "@powersync/react";
import { useEffect, useState } from "react";
import { useSession } from "../app-state/session";
import { platformFetch } from "../auth/clients";
import { appEnv } from "../config/app-env";
import { TENANT_HEADER } from "../sync/session-signals";
import {
  DMD_SUBSET_CHECK_MS,
  DMD_SUBSET_META_ID,
  DMD_SUBSET_NEEDS_META_ID,
  parseDeviceSubset,
  replaceSubsetStatements,
  SUBSET_NEEDS_SQL,
  subsetDue,
  subsetFailedStatement,
  subsetNeedsKey,
} from "./dmd-subset";

/** Who gives medicines: the phone holds a dm+d subset only for them. */
const ADMINISTER = "medicines.emar.administer";

/**
 * Keeps the phone's dm+d subset fresh while connected (ADR-0130; slice 68): asked for when the
 * phone connects, when the products on its MAR entries change, and at most hourly otherwise
 * (checked every five minutes), and replaced whole in one transaction. Offline, the last subset
 * stays; a failed request keeps it and records when it failed, so the phone can say it may be out
 * of date (clinical review of slice 68, M4 and M5).
 */
export function useDmdSubsetRefresh(): void {
  const db = usePowerSync();
  const status = useStatus();
  const { me, token } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const gives = (me?.permissions ?? []).includes(ADMINISTER);
  const { data: needRows } = useQuery<{ vmp_id: string | null; amp_id: string | null }>(
    SUBSET_NEEDS_SQL,
  );
  const needs = subsetNeedsKey(needRows);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), DMD_SUBSET_CHECK_MS);
    return () => clearInterval(timer);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-runs the check on the timer.
  useEffect(() => {
    if (appEnv.demoMode || !status.connected || !gives || !token || !tenantId) return;
    let active = true;
    (async () => {
      const kept = await db.getAll<{ id: string; value: string | null }>(
        "SELECT id, value FROM sync_meta WHERE id IN (?, ?)",
        [DMD_SUBSET_META_ID, DMD_SUBSET_NEEDS_META_ID],
      );
      const value = (id: string) => kept.find((k) => k.id === id)?.value;
      if (
        !subsetDue(value(DMD_SUBSET_META_ID), new Date(), value(DMD_SUBSET_NEEDS_META_ID), needs)
      ) {
        return;
      }
      try {
        const response = await platformFetch(`${appEnv.apiUrl}/v1/medicines/device-subset`, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            [TENANT_HEADER]: tenantId,
          },
          credentials: "omit",
        });
        if (!active) return;
        const subset = response.ok ? parseDeviceSubset(await response.json()) : null;
        if (!active) return;
        if (!subset) throw new Error("subset refused");
        const statements = replaceSubsetStatements(subset, new Date(), needs);
        await db.writeTransaction(async (tx) => {
          for (const s of statements) await tx.execute(s.sql, s.params);
        });
      } catch {
        if (!active) return;
        const failed = subsetFailedStatement(new Date());
        await db.execute(failed.sql, failed.params);
      }
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [db, status.connected, gives, token, tenantId, needs, tick]);
}

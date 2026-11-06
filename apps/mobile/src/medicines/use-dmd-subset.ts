import { usePowerSync, useStatus } from "@powersync/react";
import { useEffect } from "react";
import { useSession } from "../app-state/session";
import { platformFetch } from "../auth/clients";
import { appEnv } from "../config/app-env";
import { TENANT_HEADER } from "../sync/session-signals";
import {
  DMD_SUBSET_META_ID,
  parseDeviceSubset,
  replaceSubsetStatements,
  subsetDue,
} from "./dmd-subset";

/** Who gives medicines: the phone holds a dm+d subset only for them. */
const ADMINISTER = "medicines.emar.administer";

/**
 * Keeps the phone's dm+d subset fresh while connected (ADR-0130; slice 68): asked for when the
 * phone connects and at most hourly after, and replaced whole in one transaction. Offline, the
 * last subset stays; a failed fetch changes nothing.
 */
export function useDmdSubsetRefresh(): void {
  const db = usePowerSync();
  const status = useStatus();
  const { me, token } = useSession();
  const tenantId = me?.tenant.id ?? "";
  const gives = (me?.permissions ?? []).includes(ADMINISTER);
  useEffect(() => {
    if (appEnv.demoMode || !status.connected || !gives || !token || !tenantId) return;
    let active = true;
    (async () => {
      const kept = await db.getOptional<{ value: string | null }>(
        "SELECT value FROM sync_meta WHERE id = ?",
        [DMD_SUBSET_META_ID],
      );
      if (!subsetDue(kept?.value, new Date())) return;
      const response = await platformFetch(`${appEnv.apiUrl}/v1/medicines/device-subset`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          [TENANT_HEADER]: tenantId,
        },
        credentials: "omit",
      });
      if (!active || !response.ok) return;
      const subset = parseDeviceSubset(await response.json());
      if (!active || !subset) return;
      const statements = replaceSubsetStatements(subset, new Date());
      await db.writeTransaction(async (tx) => {
        for (const s of statements) await tx.execute(s.sql, s.params);
      });
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [db, status.connected, gives, token, tenantId]);
}

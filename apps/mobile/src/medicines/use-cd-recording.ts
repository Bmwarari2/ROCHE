/**
 * Whether controlled drug recording is on at a person's home (`cd-recording.ts`; H-1517, HZ-115):
 * the phone's kept answer at once, then a fresh read when there is a connection, which replaces it.
 * A failed read leaves the kept answer; none kept is unknown, which the record rules treat as off.
 */
import { usePowerSync } from "@powersync/react";
import { useEffect, useState } from "react";
import { useSession } from "../app-state/session";
import { platformFetch } from "../auth/clients";
import { useTenantId } from "../care/hooks";
import { appEnv } from "../config/app-env";
import {
  type CdRecording,
  cdRecordingFromMeta,
  cdRecordingMetaId,
  cdRecordingMetaValue,
  fetchCdRecording,
  PERSON_LOCATION_SQL,
  READ_CD_RECORDING_SQL,
  WRITE_CD_RECORDING_SQL,
} from "./cd-recording";

/** `ready` once the phone's kept answer (or its absence) is known, so the screen does not flicker. */
export function useCdRecording(
  personId: string,
  controlledDrug: boolean,
): { readonly recording: CdRecording; readonly ready: boolean } {
  const db = usePowerSync();
  const tenantId = useTenantId();
  const { token } = useSession();
  const [state, setState] = useState<CdRecording>("unknown");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!controlledDrug || !tenantId) return;
    let active = true;
    (async () => {
      const person = await db
        .getOptional<{ location_id: string | null }>(PERSON_LOCATION_SQL, [personId, tenantId])
        .catch(() => null);
      const locationId = person?.location_id;
      if (!locationId) {
        if (active) setReady(true);
        return;
      }
      const id = cdRecordingMetaId(tenantId, locationId);
      const kept = await db
        .getOptional<{ value: string | null }>(READ_CD_RECORDING_SQL, [id])
        .catch(() => null);
      if (active) {
        setState(cdRecordingFromMeta(kept?.value));
        setReady(true);
      }
      if (!token) return;
      const fresh = await fetchCdRecording(
        {
          apiUrl: appEnv.apiUrl,
          fetch: platformFetch,
          token,
          tenantId,
          deviceId: await db.getClientId(),
        },
        locationId,
      );
      if (fresh === null) return;
      const value = cdRecordingMetaValue(fresh, new Date());
      await db.execute(WRITE_CD_RECORDING_SQL, [id, id, value]).catch(() => undefined);
      if (active) setState(cdRecordingFromMeta(value));
    })();
    return () => {
      active = false;
    };
  }, [db, personId, tenantId, token, controlledDrug]);

  return { recording: state, ready };
}

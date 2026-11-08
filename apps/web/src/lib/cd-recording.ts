import "server-only";
import { tenantApi } from "./api";
import { cdRecordingOn } from "./controlled-drugs";

/**
 * Whether controlled drug recording is released at the location, as the API evaluates its flags
 * there (H-1517). Any failure to read counts as not released, so the paper register stays the record.
 */
export async function cdRecordingAt(locationId: string): Promise<boolean> {
  try {
    const api = await tenantApi();
    const { data } = await api.GET("/v1/me/locations/{id}/flags", {
      params: { path: { id: locationId } },
    });
    return cdRecordingOn(data?.flags);
  } catch {
    return false;
  }
}

/**
 * The same, keeping "could not read" apart from "off" for the screen that changes it (clinical
 * review of H-1518, M3): null means the screen says it could not check and offers no change.
 */
export async function cdRecordingStateAt(locationId: string): Promise<boolean | null> {
  try {
    const api = await tenantApi();
    const { data } = await api.GET("/v1/me/locations/{id}/flags", {
      params: { path: { id: locationId } },
    });
    return data ? cdRecordingOn(data.flags) : null;
  } catch {
    return null;
  }
}

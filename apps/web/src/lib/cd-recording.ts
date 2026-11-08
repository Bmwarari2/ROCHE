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

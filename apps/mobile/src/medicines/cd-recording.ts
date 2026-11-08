/**
 * Whether controlled drugs are recorded in Thapsus Care's register at a home (`medicines.cd_recording`,
 * H-1517; HZ-115), as the phone last read it. Until both the web and the phone record them there,
 * the paper register is the record and the API refuses a controlled drug's dose; the phone stops it
 * before signing instead of after the dose. Read from `GET /v1/me/locations/{id}/flags` while
 * online and kept in `sync_meta` for offline use. Never read, unreadable or a failed read counts as
 * off: a dose is never recorded on the phone on a guess.
 */
import { type ApiOptions, apiHeaders } from "./conflicts";

export const CD_RECORDING_FLAG = "medicines.cd_recording";

export type CdRecording = "on" | "off" | "unknown";

export const READ_CD_RECORDING_SQL = "SELECT value FROM sync_meta WHERE id = ?";
export const WRITE_CD_RECORDING_SQL =
  "INSERT OR REPLACE INTO sync_meta (id, key, value) VALUES (?, ?, ?)";

/** The person's home, for the read. */
export const PERSON_LOCATION_SQL = "SELECT location_id FROM person WHERE id = ? AND tenant_id = ?";

export function cdRecordingMetaId(tenantId: string, locationId: string): string {
  return `cd_recording:${tenantId}:${locationId}`;
}

/** The flag's value in the flags response for that location; null when it cannot be read. */
export function parseCdRecordingFlags(body: unknown, locationId: string): boolean | null {
  if (typeof body !== "object" || body === null) return null;
  const { locationId: at, flags } = body as { locationId?: unknown; flags?: unknown };
  if (at !== locationId || typeof flags !== "object" || flags === null) return null;
  const value = (flags as Record<string, unknown>)[CD_RECORDING_FLAG];
  return typeof value === "boolean" ? value : null;
}

/** What the phone keeps: the value and when it was read. */
export function cdRecordingMetaValue(enabled: boolean, readAt: Date): string {
  return JSON.stringify({ enabled, readAt: readAt.toISOString() });
}

/** The kept value, as the record rules take it: anything unreadable is unknown, never on. */
export function cdRecordingFromMeta(value: string | null | undefined): CdRecording {
  if (!value) return "unknown";
  try {
    const parsed = JSON.parse(value) as { enabled?: unknown; readAt?: unknown };
    if (typeof parsed.readAt !== "string" || Number.isNaN(Date.parse(parsed.readAt))) {
      return "unknown";
    }
    if (parsed.enabled === true) return "on";
    if (parsed.enabled === false) return "off";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Reads the flag at one home; null on any failure (offline, refused, unreadable). Never throws. */
export async function fetchCdRecording(o: ApiOptions, locationId: string): Promise<boolean | null> {
  try {
    const r = await o.fetch(`${o.apiUrl}/v1/me/locations/${encodeURIComponent(locationId)}/flags`, {
      method: "GET",
      headers: apiHeaders(o),
      credentials: "omit",
    });
    if (!r.ok) return null;
    return parseCdRecordingFlags(await r.json(), locationId);
  } catch {
    return null;
  }
}

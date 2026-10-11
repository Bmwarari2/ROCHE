import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The API mints the offline window into the token, so it needs the same day list as the streams.
export { OFFLINE_WINDOW_RATE_KEY, offlineWindowDays } from "../client/window";

/** Absolute path of the sync streams definition mounted into the PowerSync service. */
export const SYNC_CONFIG_PATH = fileURLToPath(new URL("./sync-config.yaml", import.meta.url));

export function readSyncConfig(): string {
  return readFileSync(SYNC_CONFIG_PATH, "utf8");
}

/**
 * Claims the API puts in the PowerSync token. The streams read nothing else, from the token or
 * from the device, so this type is the whole contract between the API and the sync service for
 * scope (tenant and people) and for the offline window (security review S1).
 */
export interface SyncTokenClaims {
  /** tenant_user id. */
  readonly sub: string;
  readonly tenant_id: string;
  /** Locations the user works at (for the location list). */
  readonly location_ids: readonly string[];
  /** Locations whose people sync in full; empty for care workers (assigned people only). */
  readonly people_location_ids: readonly string[];
  /**
   * UTC days of the offline window (`offlineWindowDays` in ../client/window.ts), from the tenant's
   * `mobile.offline_window_days` in the rate table. Without it no point-of-care entries sync.
   */
  readonly offline_days: readonly string[];
}

/** Token lifetime: short, because sync streams cannot see an assignment's end time. */
export const SYNC_TOKEN_TTL_SECONDS = 15 * 60;

/** Audience and issuer the PowerSync service is configured to accept. */
export const SYNC_TOKEN_AUDIENCE = "harbour-powersync";
export const SYNC_TOKEN_ISSUER = "harbour-api";

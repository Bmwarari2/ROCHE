import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Absolute path of the sync streams definition mounted into the PowerSync service. */
export const SYNC_CONFIG_PATH = fileURLToPath(new URL("./sync-config.yaml", import.meta.url));

export function readSyncConfig(): string {
  return readFileSync(SYNC_CONFIG_PATH, "utf8");
}

/**
 * Claims the API puts in the PowerSync token. The streams read nothing else from the token, so
 * this type is the whole contract between the API and the sync service for scope (tenant and
 * people). The device adds only the offline window, as a connection parameter
 * (`SyncConnectionParameters` in ../client/window.ts), which can narrow data but never widen it.
 */
export interface SyncTokenClaims {
  /** tenant_user id. */
  readonly sub: string;
  readonly tenant_id: string;
  /** Locations the user works at (for the location list). */
  readonly location_ids: readonly string[];
  /** Locations whose people sync in full; empty for care workers (assigned people only). */
  readonly people_location_ids: readonly string[];
}

/** Token lifetime: short, because sync streams cannot see an assignment's end time. */
export const SYNC_TOKEN_TTL_SECONDS = 15 * 60;

/** Audience and issuer the PowerSync service is configured to accept. */
export const SYNC_TOKEN_AUDIENCE = "harbour-powersync";
export const SYNC_TOKEN_ISSUER = "harbour-api";

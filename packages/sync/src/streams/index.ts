import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The API mints the offline window into the token, so it needs the same day list as the streams.
export { isValidWindowDays, OFFLINE_WINDOW_RATE_KEY, offlineWindowDays } from "../client/window";

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
  /**
   * Each stream family follows the scope of the one read permission it serves (ADR-0071 review
   * round 1, C-M1): people and allergies people.person.read where care.plan.read reaches too
   * (review round 2), the care reference and active plan details care.plan.read, recent entries
   * care.note.read. `*_location_ids` are the locations
   * whose people sync in full for that family (empty for care workers); `*_assigned` is true when
   * a role scoped to assigned people carries the family's permission, and only then do the people
   * the user is assigned to sync for it (S-M1). Missing claims sync nothing (fails closed).
   */
  readonly people_location_ids: readonly string[];
  readonly care_location_ids: readonly string[];
  readonly entries_location_ids: readonly string[];
  readonly people_assigned: boolean;
  readonly care_assigned: boolean;
  readonly entries_assigned: boolean;
  /**
   * The handover family (handovers with their items, notes and acknowledgements) follows
   * care.handover.manage, the permission the API reads handovers with: `handover_location_ids`
   * are the locations whose handovers the user sees whole, and `handover_assigned` gives the
   * handovers where the people assigned to them live, limited to those people. The open tasks
   * follow the care claims (care.plan.read, the round view's permission).
   */
  readonly handover_location_ids: readonly string[];
  readonly handover_assigned: boolean;
  /**
   * Where the phone may record (care.note.write, review round 2, C2-M3): not read by any stream,
   * only by the phone, so it never offers to record about someone the server would refuse.
   */
  readonly entries_write_location_ids: readonly string[];
  readonly entries_write_assigned: boolean;
  /**
   * The people the user is assigned to now, when `entries_write_assigned` is true, so the phone
   * decides per person where a home syncs in full for reading but the user records only about
   * the people assigned to them (review round 3, C3-M2). Absent when there are more than
   * `MAX_WRITE_PERSON_IDS` (the token stays small); the phone then offers recording and the
   * server decides.
   */
  readonly entries_write_person_ids?: readonly string[];
  /**
   * UTC days of the offline window (`offlineWindowDays` in ../client/window.ts), from the tenant's
   * `mobile.offline_window_days` in the rate table. Without it no point-of-care entries sync.
   */
  readonly offline_days: readonly string[];
  /**
   * The UTC days of the member's own shifts and clock events (`shift_days`, scheduling.md section
   * 18): empty unless the member holds `scheduling.timesheet.self`, so no shift syncs (fails closed).
   */
  readonly shift_days?: readonly string[];
  /**
   * The day and night shift start times (minutes after midnight, UK time) of each nation the
   * organisation has homes in (`england`, `wales` and so on), from the rate table, sent where the
   * handover family reaches. Not read by any stream: the phone works out from it which handover it
   * should hold, offline, and says when that one is not compiled yet or not final (ADR-0074). A
   * nation whose figures are missing is left out, and the phone then says it cannot tell.
   */
  readonly handover_shifts?: Readonly<
    Record<string, { readonly day: number; readonly night: number }>
  >;
}

/** Token lifetime: short, because sync streams cannot see an assignment's end time. */
export const SYNC_TOKEN_TTL_SECONDS = 15 * 60;

/** Audience and issuer the PowerSync service is configured to accept. */
export const SYNC_TOKEN_AUDIENCE = "harbour-powersync";
export const SYNC_TOKEN_ISSUER = "harbour-api";

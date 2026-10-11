/**
 * App-wide policy values. None of these is a statutory figure; they are product safety settings
 * from the master prompt (section 17.2) and the clinical safety case.
 */

/**
 * Offline data older than this carries a "may be out of date" warning (hazard HZ-002). Phase 0
 * default; it becomes a tenant setting with the tenant's offline window.
 */
export const STALE_AFTER_MS = 15 * 60_000;

/** The URL scheme registered in app.config.ts, sent as the Origin of auth requests. */
export const APP_ORIGIN = "harbour://";

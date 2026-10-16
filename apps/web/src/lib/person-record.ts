import "server-only";
import type { OutageItem } from "@harbour/contracts";
import { cache } from "react";
import { failWith, problemCode, tenantApi } from "./api";
import { paperOutages } from "./back-entry";
import { isUuid } from "./context-cookies";
import {
  type CareProfileLoad,
  type PersonRecord,
  readCareProfile,
  readPersonSummary,
} from "./record-data";

/**
 * Loads what every tab of a person's record needs. Cached per request, so the header and the
 * tab's page share one call each; every tab renders the header itself, so moving between tabs
 * reads it again (HZ-002, HZ-015). The web tier holds no data of its own: every value comes from
 * the API, which checks scope and audits the read, and is checked against the API's schema here.
 */

export type PersonLoad =
  | { readonly person: PersonRecord; readonly code: null }
  /** "not_found", "missing_permission" or "unreadable" (the answer did not match the schema). */
  | { readonly person: null; readonly code: string };

export const getPerson = cache(async (id: string): Promise<PersonLoad> => {
  if (!isUuid(id)) return { person: null, code: "not_found" };
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/people/{id}", {
    params: { path: { id } },
  });
  if (data) {
    const person = readPersonSummary(data);
    return person ? { person, code: null } : { person: null, code: "unreadable" };
  }
  const code = problemCode(error);
  if (code === "not_found" || code === "missing_permission" || response.status === 404) {
    return { person: null, code: code ?? "not_found" };
  }
  return failWith(error, response, `/people/${id}`);
});

/** IDDSI levels, fluid target, SpO2 scale and skin risk, or why they cannot be shown. */
export const getCareProfile = cache(async (id: string): Promise<CareProfileLoad> => {
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/people/{id}/care-profile", {
    params: { path: { id } },
  });
  if (data) return readCareProfile(data);
  if (problemCode(error) === "missing_permission") return { kind: "no_access" };
  return failWith(error, response, `/people/${id}`);
});

/**
 * Unwraps an API read for a tab. A missing permission gives null, so the tab can say so in
 * words; anything else unexpected goes to the error boundary (or sign-in when the session ended).
 */
export function readOrFail<T>(
  result: { data?: T; error?: unknown; response: Response },
  path: string,
): T | null {
  if (result.data !== undefined) return result.data;
  if (problemCode(result.error) === "missing_permission") return null;
  return failWith(result.error, result.response, path);
}

/**
 * The outages at the person's location a paper record can still be entered against (open or
 * closed), for the care record forms (operations.md section 14; HZ-017). Empty when they cannot
 * be read: the forms then offer no paper choice, and the API still refuses an entry for a time in
 * an outage without its details, in words the form shows.
 */
export const getEntryOutages = cache(async (locationId: string): Promise<OutageItem[]> => {
  if (!isUuid(locationId)) return [];
  const api = await tenantApi();
  const { data } = await api.GET("/v1/locations/{id}/outages", {
    params: { path: { id: locationId } },
  });
  return data ? paperOutages(data.items) : [];
});

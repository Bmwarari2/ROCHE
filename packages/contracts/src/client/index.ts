import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import { DEVICE_HEADER, TENANT_HEADER } from "../index";
import type { components, paths } from "./api-types";

/**
 * The one typed API client (section 6), generated from the API's OpenAPI 3.1 document
 * (apps/api/openapi.json; regenerate with `pnpm --filter @harbour/contracts generate:client`).
 * Used by the web app's server components and actions, and by the mobile app.
 */
export type ApiClient = Client<paths>;
export type { components, paths };

export interface ApiClientOptions extends ClientOptions {
  /** The active organisation (x-harbour-tenant). */
  readonly tenantId?: string;
  /** Session token for bearer authentication (mobile); the web forwards the session cookie instead. */
  readonly bearerToken?: string;
  readonly deviceId?: string;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { tenantId, bearerToken, deviceId, headers, ...rest } = options;
  const merged = new Headers(headers as HeadersInit | undefined);
  if (tenantId) merged.set(TENANT_HEADER, tenantId);
  if (bearerToken) merged.set("authorization", `Bearer ${bearerToken}`);
  if (deviceId) merged.set(DEVICE_HEADER, deviceId);
  return createClient<paths>({ ...rest, headers: Object.fromEntries(merged.entries()) });
}

import "server-only";
import type { DeviceSession } from "@harbour/contracts";
import { headers } from "next/headers";
import { API_URL, serverApi } from "./api";

/**
 * Sign-in settings, called from the server with the person's own cookie: Better Auth endpoints
 * that are not part of the OpenAPI contract (the session's user, passkeys) and the API's device
 * list. The API never returns session tokens to the web (only the mobile app gets one), so devices
 * are listed and signed out by id.
 */

export interface AuthSessionUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly twoFactorEnabled?: boolean | null;
}

export interface AuthPasskey {
  readonly id: string;
  readonly name?: string | null;
  readonly createdAt: string;
  readonly deviceType?: string | null;
}

async function authHeaders(json: boolean): Promise<Record<string, string>> {
  const incoming = await headers();
  const out: Record<string, string> = {};
  const cookie = incoming.get("cookie");
  if (cookie) out.cookie = cookie;
  const userAgent = incoming.get("user-agent");
  if (userAgent) out["user-agent"] = userAgent;
  // Better Auth checks the Origin of cookie-authenticated POSTs. Server actions always carry the
  // browser's Origin, which Next.js has already matched to this host.
  const origin = incoming.get("origin");
  if (origin) out.origin = origin;
  if (json) out["content-type"] = "application/json";
  return out;
}

async function authFetch<T>(path: string, body?: unknown): Promise<T | null> {
  const response = await fetch(`${API_URL}/api/auth${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: await authHeaders(body !== undefined),
    cache: "no-store",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) return null;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
}

export async function getAuthSession(): Promise<{
  session: { id: string };
  user: AuthSessionUser;
} | null> {
  return authFetch("/get-session");
}

/** Devices where the person is signed in, this one marked `current`. */
export async function listDeviceSessions(): Promise<DeviceSession[]> {
  const api = await serverApi();
  const { data } = await api.GET("/v1/me/sessions");
  return data?.items ?? [];
}

export async function listPasskeys(): Promise<AuthPasskey[]> {
  return (await authFetch<AuthPasskey[]>("/passkey/list-user-passkeys")) ?? [];
}

/** Signs out one of the person's own devices. */
export async function revokeDeviceSession(sessionId: string): Promise<boolean> {
  const api = await serverApi();
  const { response } = await api.POST("/v1/me/sessions/{id}/revoke", {
    params: { path: { id: sessionId } },
  });
  return response.status === 204;
}

/** Signs out every device except this one. */
export async function revokeOtherDeviceSessions(): Promise<boolean> {
  const api = await serverApi();
  const { response } = await api.POST("/v1/me/sessions/revoke-others");
  return response.ok;
}

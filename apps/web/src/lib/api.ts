import "server-only";
import type { Me, ProblemDetails } from "@harbour/contracts";
import { type ApiClient, createApiClient } from "@harbour/contracts/client";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { LOCATION_COOKIE, selectLocation, selectTenant, TENANT_COOKIE } from "./context-cookies";
import { redirectForProblem } from "./problems";

/**
 * Server-side access to the Harbour API. Server components and server actions call the API
 * directly (not through the browser-facing rewrite), forwarding the person's session cookie and
 * the active organisation. The web tier holds no credentials of its own and no database access.
 */
export const API_URL = (
  process.env.API_URL ??
  process.env.API_BASE_URL ??
  "http://localhost:4000"
).replace(/\/+$/, "");

/** Request headers passed on to the API: the session cookie, and what the audit log records. */
const FORWARDED = ["cookie", "user-agent", "x-forwarded-for", "x-request-id"] as const;

async function forwardedHeaders(): Promise<Record<string, string>> {
  const incoming = await headers();
  const out: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = incoming.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/** A typed API client acting as the signed-in person, optionally for one organisation. */
export async function serverApi(tenantId?: string): Promise<ApiClient> {
  return createApiClient({
    baseUrl: API_URL,
    headers: await forwardedHeaders(),
    cache: "no-store",
    ...(tenantId ? { tenantId } : {}),
  });
}

/** A failed API call the page did not handle itself. Its message is safe to log (no personal data). */
export class ApiProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Harbour API returned ${status} (${code})`);
    this.name = "ApiProblemError";
  }
}

export function problemCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as Pick<ProblemDetails, "code">;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/**
 * Sends the person where the problem says they should go (sign in, choose an organisation, set
 * up MFA), or throws for the nearest error boundary.
 */
export function failWith(error: unknown, response: Response, nextPath?: string): never {
  const code = problemCode(error);
  const target = redirectForProblem(code, nextPath);
  if (target) redirect(target);
  throw new ApiProblemError(response.status, code ?? "internal");
}

export interface ShellContext {
  readonly me: Me;
  readonly tenantId: string;
  /** The chosen location, or null for every location in the person's scope. */
  readonly locationId: string | null;
}

/**
 * Who is signed in, for which organisation and location. Cached for the request, so the layout
 * and the page share one pair of API calls.
 */
export const getShellContext = cache(async (): Promise<ShellContext> => {
  const jar = await cookies();
  const sessionApi = await serverApi();
  const memberships = await sessionApi.GET("/v1/memberships");
  if (!memberships.data) failWith(memberships.error, memberships.response);

  const selection = selectTenant(jar.get(TENANT_COOKIE)?.value, memberships.data.items);
  if (selection.kind !== "selected") redirect("/choose-organisation");

  const api = await serverApi(selection.tenantId);
  const me = await api.GET("/v1/me");
  if (!me.data) failWith(me.error, me.response);

  return {
    me: me.data,
    tenantId: selection.tenantId,
    locationId: selectLocation(jar.get(LOCATION_COOKIE)?.value, me.data.locations),
  };
});

/** The API client for the active organisation. */
export async function tenantApi(): Promise<ApiClient> {
  const { tenantId } = await getShellContext();
  return serverApi(tenantId);
}

/** Whether the request came over HTTPS (behind CloudFront and the load balancer) or production. */
export async function isSecureRequest(): Promise<boolean> {
  const incoming = await headers();
  const proto = incoming.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]?.trim() === "https";
  return process.env.NODE_ENV === "production";
}

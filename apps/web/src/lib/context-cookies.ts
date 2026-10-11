/**
 * The active organisation (tenant) and location live in two cookies so every server render and
 * server action calls the API for the same context. Pure helpers: no Next.js imports, so they are
 * unit tested directly.
 */

export const TENANT_COOKIE = "harbour_tenant";
export const LOCATION_COOKIE = "harbour_location";

/** A year: the choice is a preference, not a credential. The session cookie governs access. */
const CONTEXT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface MembershipChoice {
  readonly tenantId: string;
  readonly tenantName: string;
}

export type TenantSelection =
  | { readonly kind: "selected"; readonly tenantId: string; readonly fromCookie: boolean }
  | { readonly kind: "choose" }
  | { readonly kind: "none" };

/**
 * Picks the organisation to act for. The cookie wins when it names one of the person's current
 * memberships; a stale or tampered cookie is ignored. With one membership there is nothing to
 * choose. With several and no valid cookie the person must choose.
 */
export function selectTenant(
  cookieValue: string | undefined | null,
  memberships: readonly MembershipChoice[],
): TenantSelection {
  if (memberships.length === 0) return { kind: "none" };
  if (cookieValue) {
    const match = memberships.find((m) => m.tenantId === cookieValue);
    if (match) return { kind: "selected", tenantId: match.tenantId, fromCookie: true };
  }
  const [only] = memberships;
  if (memberships.length === 1 && only) {
    return { kind: "selected", tenantId: only.tenantId, fromCookie: false };
  }
  return { kind: "choose" };
}

/**
 * The location filter, or null for all locations in the person's scope. A location the person can
 * no longer see (or one from another organisation) falls back to all.
 */
export function selectLocation(
  cookieValue: string | undefined | null,
  locations: readonly { readonly id: string }[],
): string | null {
  if (!cookieValue) return null;
  return locations.some((l) => l.id === cookieValue) ? cookieValue : null;
}

export interface ContextCookieOptions {
  readonly httpOnly: boolean;
  readonly sameSite: "lax";
  readonly secure: boolean;
  readonly path: "/";
  readonly maxAge: number;
}

/** The tenant cookie is httpOnly; the location cookie may be read by scripts (it is not sensitive). */
export function contextCookieOptions(
  kind: "tenant" | "location",
  secure: boolean,
): ContextCookieOptions {
  return {
    httpOnly: kind === "tenant",
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: CONTEXT_COOKIE_MAX_AGE,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only well-formed ids are written to cookies or sent as the tenant header. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

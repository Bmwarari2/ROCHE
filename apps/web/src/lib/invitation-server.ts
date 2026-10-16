import "server-only";
import { passwordRuleBroken } from "@harbour/domain";
import { cookies } from "next/headers";
import { isSecureRequest, problemCode, serverApi } from "@/lib/api";
import { contextCookieOptions, LOCATION_COOKIE, TENANT_COOKIE } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import {
  type AcceptResult,
  asRefusal,
  destinationAfterAccept,
  isInvitationToken,
  type LookupResult,
  retryMinutes,
} from "@/lib/invitations";

/**
 * The invitation page's calls to the API (PLAT-004), behind the route handlers in
 * app/api/invitations. The page posts the token to them in a JSON body; it goes on to the API in
 * a request body, with the person's session cookie when they have one. Nothing here logs, stores
 * or returns it.
 */

/** What a failed call means for the page: throttled, unknown, refused, or unreachable. */
function failure(
  status: number,
  error: unknown,
  response: Response,
): Exclude<LookupResult, { kind: "found" }> {
  if (status === 429) {
    return { kind: "throttled", minutes: retryMinutes(response.headers.get("retry-after")) };
  }
  if (status === 404) return { kind: "refused", refusal: "not_found" };
  if (status === 409) return { kind: "refused", refusal: asRefusal(problemCode(error)) };
  // A malformed token is refused by the API's schema; to the person it is a link that does not work.
  if (status === 422) return { kind: "refused", refusal: "not_found" };
  return { kind: "unavailable" };
}

export async function lookupInvitation(token: string): Promise<LookupResult> {
  if (!isInvitationToken(token)) return { kind: "refused", refusal: "not_found" };
  try {
    const api = await serverApi();
    const { data, error, response } = await api.POST("/v1/invitations/lookup", {
      body: { token },
    });
    if (!data) return failure(response.status, error, response);
    if (data.refusal) return { kind: "refused", refusal: asRefusal(data.refusal) };
    return {
      kind: "found",
      organisationName: data.organisationName,
      emailMasked: data.emailMasked,
      expiresAt: formatDateTime(data.expiresAt) ?? "",
      path: data.path,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface AcceptInput {
  readonly token: string;
  /** Only when creating a sign-in. */
  readonly name?: string;
  readonly password?: string;
}

export async function acceptInvitation(input: AcceptInput): Promise<AcceptResult> {
  const { token } = input;
  if (!isInvitationToken(token)) return { kind: "refused", refusal: "not_found" };
  const creating = input.password !== undefined || input.name !== undefined;
  const name = input.name?.trim() ?? "";
  if (creating) {
    // The same NCSC rules the API applies (@harbour/domain), so the reason shows at the field.
    const rule = input.password ? passwordRuleBroken(input.password) : "passwordRequired";
    if (!name || rule) {
      return {
        kind: "invalid",
        ...(name ? {} : { name: "nameRequired" as const }),
        ...(rule ? { password: rule } : {}),
      };
    }
  }
  try {
    const api = await serverApi();
    const { data, error, response } = await api.POST("/v1/invitations/accept", {
      body: creating ? { token, name, password: input.password ?? "" } : { token },
    });
    if (!data) {
      if (response.status === 409 && problemCode(error) === "sign_in_first") {
        return { kind: "sign_in_first" };
      }
      // The checks above match the API's, so a 422 here is a link that does not work.
      return failure(response.status, error, response);
    }
    // Start in the organisation just joined; the API still decides what the person may see.
    const jar = await cookies();
    jar.set(TENANT_COOKIE, data.tenantId, contextCookieOptions("tenant", await isSecureRequest()));
    jar.delete(LOCATION_COOKIE);
    return { kind: "accepted", next: data.next, destination: destinationAfterAccept(data.next) };
  } catch {
    return { kind: "unavailable" };
  }
}

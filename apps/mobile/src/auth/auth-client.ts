/**
 * Client for the Harbour API's Better Auth endpoints (bearer plugin) and `/v1/me`.
 *
 * Implemented with fetch rather than `@better-auth/expo`: that package needs `better-auth` and
 * `@better-auth/core` (server code) in the app bundle and emulates cookies, whereas the bearer flow
 * is two calls. The session token arrives in the `set-auth-token` header and is sent back as
 * `Authorization: Bearer <token>`. For accounts with TOTP, sign-in answers `twoFactorRedirect`
 * and sets a short-lived two-factor cookie that must accompany the verify call.
 */
import { isSessionProblem, readProblemBody, TENANT_HEADER } from "../sync/session-signals";
import { cookiePairsFromSetCookie, type FetchLike, HttpError } from "./http";

export type AuthErrorKind =
  | "invalid_credentials"
  | "invalid_code"
  | "rate_limited"
  | "session_expired"
  | "network"
  | "server"
  | "unexpected";

/** User-facing messages: plain English, never blaming the user. */
const messages: Record<AuthErrorKind, string> = {
  invalid_credentials:
    "We could not sign you in with those details. Check your email address and password, then try again.",
  invalid_code:
    "That code did not work. Codes change every 30 seconds, so enter the latest one from your authenticator app.",
  rate_limited: "There have been several attempts in a short time. Wait a minute, then try again.",
  session_expired: "Your session has ended. Sign in again to continue.",
  network: "Harbour cannot be reached. Check your internet connection and try again.",
  server: "Harbour is not responding as expected. Try again in a few minutes.",
  unexpected: "Something went wrong while signing in. Try again.",
};

export class AuthError extends Error {
  readonly kind: AuthErrorKind;

  constructor(kind: AuthErrorKind, cause?: unknown) {
    super(messages[kind], cause === undefined ? undefined : { cause });
    this.name = "AuthError";
    this.kind = kind;
  }
}

export interface TwoFactorChallenge {
  /** Cookie header carrying the pending two-factor state from the sign-in response. */
  readonly cookie: string;
}

export type SignInResult =
  | { readonly kind: "signed_in"; readonly token: string }
  | { readonly kind: "two_factor_required"; readonly challenge: TwoFactorChallenge };

export interface Me {
  readonly user: { readonly id: string; readonly name: string };
  readonly tenant: { readonly id: string; readonly name: string };
  /**
   * The tenant_user id: who owns entries written on this device. Null when an older cached answer
   * lacks it (the auth user id and tenant are compared instead).
   */
  readonly tenantUserId: string | null;
  readonly locations: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly permissions: readonly string[];
  /**
   * The organisation's feature flags, as `/v1/me` evaluates them (only true or false values are
   * kept); absent on an older cached answer. Care mode reads `care.mobile_care_mode` (H-381).
   */
  readonly flags?: Readonly<Record<string, boolean>>;
}

export interface AuthClient {
  signInWithEmail(email: string, password: string): Promise<SignInResult>;
  verifyTotp(challenge: TwoFactorChallenge, code: string): Promise<string>;
  /** Best effort: revokes the session server-side; never throws. */
  signOut(token: string): Promise<void>;
  /** The signed-in user; `tenantId` picks the organisation for staff who belong to more than one. */
  getMe(token: string, tenantId?: string | null): Promise<Me>;
}

export interface AuthClientOptions {
  readonly baseUrl: string;
  readonly fetch: FetchLike;
  /** Origin header for auth requests; the API lists the app scheme as a trusted origin. */
  readonly origin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdName(value: unknown): value is { id: string; name: string } {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

/** Validates the `/v1/me` payload; anything unexpected is a server error, not a crash. */
export function parseMe(value: unknown): Me {
  if (
    !isRecord(value) ||
    !isIdName(value.user) ||
    !isIdName(value.tenant) ||
    !Array.isArray(value.locations) ||
    !value.locations.every(isIdName) ||
    !Array.isArray(value.permissions) ||
    !value.permissions.every((p): p is string => typeof p === "string")
  ) {
    throw new AuthError("server");
  }
  return {
    user: { id: value.user.id, name: value.user.name },
    tenant: { id: value.tenant.id, name: value.tenant.name },
    tenantUserId:
      typeof value.tenantUserId === "string" && value.tenantUserId ? value.tenantUserId : null,
    locations: value.locations.map((l) => ({ id: l.id, name: l.name })),
    permissions: [...value.permissions],
    flags: isRecord(value.flags)
      ? Object.fromEntries(
          Object.entries(value.flags).filter(
            (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
          ),
        )
      : {},
  };
}

/** Normalises a TOTP code: digits only, exactly six. */
export function normaliseTotpCode(code: string): string | null {
  const digits = code.replace(/\s+/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorForStatus(status: number, unauthorised: AuthErrorKind): AuthError {
  if (status === 401 || status === 403) return new AuthError(unauthorised);
  if (status === 429) return new AuthError("rate_limited");
  if (status >= 500) return new AuthError("server", new HttpError(status, "Server error"));
  if (status === 400 || status === 422) return new AuthError(unauthorised);
  return new AuthError("unexpected", new HttpError(status, "Unexpected status"));
}

function tokenFrom(response: Response, body: unknown): string | null {
  const header = response.headers.get("set-auth-token");
  if (header) return header;
  if (isRecord(body) && typeof body.token === "string" && body.token.length > 0) return body.token;
  return null;
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const { baseUrl, origin } = options;
  const doFetch: FetchLike = async (input, init) => {
    try {
      return await options.fetch(input, init);
    } catch (error) {
      throw new AuthError("network", error);
    }
  };

  const jsonHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: origin,
  };

  return {
    async signInWithEmail(email, password) {
      const response = await doFetch(`${baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: jsonHeaders,
        // Cookies are handled explicitly below; the native cookie jar must not add its own.
        credentials: "omit",
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await readJson(response);
      if (!response.ok) throw errorForStatus(response.status, "invalid_credentials");

      if (isRecord(body) && body.twoFactorRedirect === true) {
        const cookie = cookiePairsFromSetCookie(response.headers.get("set-cookie")).join("; ");
        return { kind: "two_factor_required", challenge: { cookie } };
      }
      const token = tokenFrom(response, body);
      if (!token) throw new AuthError("server");
      return { kind: "signed_in", token };
    },

    async verifyTotp(challenge, code) {
      const normalised = normaliseTotpCode(code);
      if (!normalised) throw new AuthError("invalid_code");
      const response = await doFetch(`${baseUrl}/api/auth/two-factor/verify-totp`, {
        method: "POST",
        headers: challenge.cookie ? { ...jsonHeaders, Cookie: challenge.cookie } : jsonHeaders,
        credentials: "omit",
        body: JSON.stringify({ code: normalised }),
      });
      const body = await readJson(response);
      if (!response.ok) throw errorForStatus(response.status, "invalid_code");
      const token = tokenFrom(response, body);
      if (!token) throw new AuthError("server");
      return token;
    },

    async signOut(token) {
      try {
        await options.fetch(`${baseUrl}/api/auth/sign-out`, {
          method: "POST",
          headers: { ...jsonHeaders, Authorization: `Bearer ${token}` },
          credentials: "omit",
          body: "{}",
        });
      } catch {
        // Offline sign-out still wipes the device; the server session expires on its own.
      }
    },

    async getMe(token, tenantId) {
      const response = await doFetch(`${baseUrl}/v1/me`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(tenantId ? { [TENANT_HEADER]: tenantId } : {}),
        },
        credentials: "omit",
      });
      // A 403 ends the session only with a session problem code; an edge block or an unknown
      // code is not evidence that it has ended (security review round 3, H1).
      if (response.status === 403) {
        const problem = await readProblemBody(response);
        throw new AuthError(isSessionProblem(problem.code) ? "session_expired" : "server");
      }
      if (!response.ok) throw errorForStatus(response.status, "session_expired");
      return parseMe(await readJson(response));
    },
  };
}

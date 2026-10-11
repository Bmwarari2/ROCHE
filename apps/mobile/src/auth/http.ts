/** Minimal fetch shape so modules can be tested with a fake and run on React Native's fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A non-2xx response. `retryAfterMs` comes from a Retry-After header when present. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parses Retry-After (seconds or an HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Status codes worth retrying: timeouts, rate limits and server-side failures. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Splits a combined Set-Cookie header (React Native joins multiple cookies with commas) into
 * "name=value" pairs suitable for a Cookie request header. Commas inside Expires dates are kept.
 */
export function cookiePairsFromSetCookie(header: string | null): string[] {
  if (!header) return [];
  return header
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("=") && !pair.startsWith("="));
}

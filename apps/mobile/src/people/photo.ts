/**
 * Person photos come from the API (`GET /v1/people/{id}/photo`, bearer token), never from a
 * pre-signed URL, and are held in memory only: they are not written to the image cache on disk,
 * which would sit outside the encrypted database. The API must answer with
 * `Cache-Control: no-store` so the native HTTP stack does not keep a copy either.
 */
import type { FetchLike } from "../auth/http";

export const ALLOWED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Photos larger than this are not shown (protects memory on low-end devices). */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 with padding (RFC 4648), without relying on btoa or Buffer. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += `${ALPHABET.charAt((n >> 18) & 63)}${ALPHABET.charAt((n >> 12) & 63)}==`;
  } else if (remaining === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += `${ALPHABET.charAt((n >> 18) & 63)}${ALPHABET.charAt((n >> 12) & 63)}${ALPHABET.charAt((n >> 6) & 63)}=`;
  }
  return out;
}

/** A small least-recently-used cache of photo data URIs, held in memory only. */
export class PhotoMemoryCache {
  private readonly entries = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 60) {
    this.maxEntries = maxEntries;
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Cache key: a new document id means a new photo. */
export function photoCacheKey(personId: string, photoDocumentId: string): string {
  return `${personId}:${photoDocumentId}`;
}

export interface FetchPhotoOptions {
  readonly apiUrl: string;
  readonly personId: string;
  readonly token: string;
  readonly fetch: FetchLike;
}

/**
 * Fetches a person's photo as a data URI, or null on any failure (offline, 404, wrong type, too
 * large), in which case the caller shows initials.
 */
export async function fetchPersonPhoto(options: FetchPhotoOptions): Promise<string | null> {
  try {
    const response = await options.fetch(
      `${options.apiUrl}/v1/people/${encodeURIComponent(options.personId)}/photo`,
      {
        method: "GET",
        headers: {
          Accept: ALLOWED_PHOTO_TYPES.join(", "),
          Authorization: `Bearer ${options.token}`,
          // React Native's fetch has no `cache` option; the request header and the API's
          // `Cache-Control: no-store` response keep the native HTTP cache from storing the photo.
          "Cache-Control": "no-store",
        },
        credentials: "omit",
      },
    );
    if (!response.ok) return null;
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!type || !(ALLOWED_PHOTO_TYPES as readonly string[]).includes(type)) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_PHOTO_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) return null;
    return `data:${type};base64,${bytesToBase64(bytes)}`;
  } catch {
    return null;
  }
}

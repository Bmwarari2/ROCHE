/**
 * Keeping and enrolling the medicines PIN keys on this phone (ADR-0084; slice 70). Each key sits in
 * its own `sync_meta` row in the encrypted database, so it goes with this database (and its device
 * id) and never outlives it. Enrolment sends the public half with a session that has just signed in
 * with a second factor (the step-up the API asks for): the signed-in member's own, or a witness's
 * who signs in on this phone for this alone. That session is ended straight after.
 */
import type { FetchLike } from "../auth/http";
import { DEVICE_HEADER, TENANT_HEADER } from "../sync/connector";
import type { MetaStore } from "../sync/offline-window";
import { DEVICE_KEY_META_PREFIX, parseWrappedKey, type WrappedKey } from "./device-key";

export const DEVICE_KEYS_SQL = "SELECT id, value FROM sync_meta WHERE id LIKE ? ORDER BY id";
export const deviceKeysParams = [`${DEVICE_KEY_META_PREFIX}%`];

export function keysFrom(rows: readonly { value: string }[]): WrappedKey[] {
  return rows.map((r) => parseWrappedKey(r.value)).filter((k): k is WrappedKey => k !== null);
}

export async function saveWrappedKey(db: MetaStore, key: WrappedKey): Promise<void> {
  const id = `${DEVICE_KEY_META_PREFIX}${key.memberId}`;
  await db.execute("DELETE FROM sync_meta WHERE id = ?", [id]);
  await db.execute("INSERT INTO sync_meta (id, key, value) VALUES (?, ?, ?)", [
    id,
    "device_key",
    JSON.stringify(key),
  ]);
}

export type EnrolResult =
  | { readonly kind: "enrolled"; readonly keyId: string }
  | { readonly kind: "refused"; readonly status: number; readonly code: string | null }
  | { readonly kind: "offline" };

/** Sends the public key with the just-signed-in session; never throws. */
export async function enrolDeviceKey(options: {
  readonly apiUrl: string;
  readonly fetch: FetchLike;
  readonly token: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly publicKey: string;
}): Promise<EnrolResult> {
  try {
    const response = await options.fetch(`${options.apiUrl}/v1/me/device-keys`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
        [TENANT_HEADER]: options.tenantId,
        [DEVICE_HEADER]: options.deviceId,
      },
      credentials: "omit",
      body: JSON.stringify({ publicKey: options.publicKey }),
    });
    const body = (await response.json().catch(() => null)) as {
      id?: unknown;
      code?: unknown;
    } | null;
    if (response.ok && typeof body?.id === "string") return { kind: "enrolled", keyId: body.id };
    return {
      kind: "refused",
      status: response.status,
      code: typeof body?.code === "string" ? body.code : null,
    };
  } catch {
    return { kind: "offline" };
  }
}

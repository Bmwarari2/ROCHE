/**
 * Each member's signing key on this phone (ADR-0084; Phase 2 slice 70). When a member sets their
 * medicines PIN, the phone makes an ECDSA P-256 key, sends the public half to
 * `POST /v1/me/device-keys` and keeps the private half wrapped by the PIN (scrypt, then AES-256-GCM)
 * in the phone's encrypted database. To sign a controlled drug's dose offline, as its recorder or
 * its witness, the member types their PIN on this phone; the API verifies the signature when the
 * dose arrives. A wrong PIN is throttled, never locked out for good (NCSC). Pure apart from the
 * random bytes the caller passes, so every rule is tested without a device.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { p256 } from "@noble/curves/nist.js";
import { scrypt } from "@noble/hashes/scrypt.js";

/** scrypt cost: about a second on a mid-range phone, so a stolen copy of the database is slow to guess. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;
export const PIN_MIN_LENGTH = 6;
/** Wrong PINs before the phone makes the member wait, doubling each time after. */
export const PIN_FREE_ATTEMPTS = 5;
const BASE_WAIT_MS = 30_000;

export type PinProblem = "too_short" | "not_digits" | "all_same" | "sequence" | "mismatch";

/** Why a new PIN cannot be used, or none: six or more digits, not one digit repeated or a run. */
export function pinProblems(pin: string, confirm: string): PinProblem[] {
  const problems: PinProblem[] = [];
  if (!/^\d+$/.test(pin)) problems.push("not_digits");
  if (pin.length < PIN_MIN_LENGTH) problems.push("too_short");
  if (/^(\d)\1+$/.test(pin)) problems.push("all_same");
  const digits = [...pin].map(Number);
  const run = (step: number) =>
    digits.every((d, i) => i === 0 || d === ((digits[i - 1] as number) + step + 10) % 10);
  if (pin.length >= 3 && /^\d+$/.test(pin) && (run(1) || run(-1))) problems.push("sequence");
  if (pin !== confirm) problems.push("mismatch");
  return problems;
}

export interface WrappedKey {
  readonly memberId: string;
  /** The member's name as Harbour gave it at enrolment, to choose a witness by. */
  readonly name?: string;
  /** The server's id for the key (member_device_key.id), once enrolled. */
  readonly keyId: string;
  readonly publicKey: string;
  readonly salt: string;
  readonly nonce: string;
  readonly sealed: string;
  /** Wrong PINs since the last right one, and when the member may try again. */
  readonly failures: number;
  readonly waitUntil: string | null;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * A new key from 32 random bytes (the caller's secure source), sealed with the PIN. `keyId` is
 * filled once the server has it.
 */
export function newWrappedKey(
  memberId: string,
  pin: string,
  random: (length: number) => Uint8Array,
): Omit<WrappedKey, "keyId"> {
  let secret = random(32);
  while (!p256.utils.isValidSecretKey(secret)) secret = random(32);
  const salt = random(16);
  const nonce = random(12);
  const wrappingKey = scrypt(new TextEncoder().encode(pin), salt, SCRYPT);
  const sealed = gcm(wrappingKey, nonce, new TextEncoder().encode(memberId)).encrypt(secret);
  return {
    memberId,
    publicKey: b64(p256.getPublicKey(secret, false)),
    salt: b64(salt),
    nonce: b64(nonce),
    sealed: b64(sealed),
    failures: 0,
    waitUntil: null,
  };
}

export type UnlockResult =
  | { readonly kind: "unlocked"; readonly secret: Uint8Array; readonly key: WrappedKey }
  | { readonly kind: "wrong_pin"; readonly key: WrappedKey }
  | { readonly kind: "wait"; readonly until: Date };

/** Opens the key with the PIN, or counts a wrong one and says how long to wait from the sixth. */
export function unlockKey(key: WrappedKey, pin: string, now: Date): UnlockResult {
  if (key.waitUntil && new Date(key.waitUntil).getTime() > now.getTime()) {
    return { kind: "wait", until: new Date(key.waitUntil) };
  }
  try {
    const wrappingKey = scrypt(new TextEncoder().encode(pin), unb64(key.salt), SCRYPT);
    const secret = gcm(
      wrappingKey,
      unb64(key.nonce),
      new TextEncoder().encode(key.memberId),
    ).decrypt(unb64(key.sealed));
    return { kind: "unlocked", secret, key: { ...key, failures: 0, waitUntil: null } };
  } catch {
    const failures = key.failures + 1;
    const over = failures - PIN_FREE_ATTEMPTS;
    const waitUntil =
      over > 0
        ? new Date(now.getTime() + BASE_WAIT_MS * 2 ** Math.min(over - 1, 10)).toISOString()
        : null;
    return { kind: "wrong_pin", key: { ...key, failures, waitUntil } };
  }
}

/** The signature the API verifies: ECDSA P-256 over SHA-256 of the text, r||s, base64. */
export function signText(secret: Uint8Array, text: string): string {
  return b64(
    p256.sign(new TextEncoder().encode(text), secret, { prehash: true, format: "compact" }),
  );
}

/** Where each member's key is kept: one `sync_meta` row each, in the encrypted database. */
export const DEVICE_KEY_META_PREFIX = "meta:device-key:";

export function parseWrappedKey(value: string | null | undefined): WrappedKey | null {
  if (!value) return null;
  try {
    const k = JSON.parse(value) as Partial<WrappedKey>;
    return typeof k.memberId === "string" &&
      typeof k.keyId === "string" &&
      typeof k.publicKey === "string" &&
      typeof k.salt === "string" &&
      typeof k.nonce === "string" &&
      typeof k.sealed === "string" &&
      typeof k.failures === "number"
      ? (k as WrappedKey)
      : null;
  } catch {
    return null;
  }
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { DocumentStoragePort, HealthResult, TenantKeyPort } from "@harbour/domain";

/**
 * Envelope encryption for stored objects (PLAT-012; platform.md, Crypto-shredding; ADR-0109).
 *
 * Every object gets a fresh 256-bit data key, wrapped by its organisation's key (`TenantKeyPort`)
 * and kept in the object's header, and is encrypted with AES-256-GCM in segments of at most 64
 * KiB, so an export streams without being held in memory.
 *
 *   header  = "HBE1" | version (1) | nonce prefix (7) | wrapped key length (2, big-endian) | wrapped key
 *   segment = final flag (1) | plaintext length (4, big-endian) | ciphertext | GCM tag (16)
 *
 * Each segment's nonce is the prefix, a 4-byte counter and the final flag; its additional data is
 * the header and the storage key. So a changed byte, a dropped, repeated or reordered segment, a
 * missing final segment, trailing bytes, or an object copied to another key all fail to decrypt.
 * Destroying the organisation's key makes every one of its objects unreadable.
 */

export const ENVELOPE_MAGIC = Buffer.from("HBE1", "ascii");
const VERSION = 1;
const PREFIX_BYTES = 7;
const TAG_BYTES = 16;
export const SEGMENT_BYTES = 64 * 1024;
const HEADER_FIXED = ENVELOPE_MAGIC.length + 1 + PREFIX_BYTES + 2;
const SEGMENT_HEADER = 1 + 4;

/** The object cannot be decrypted: it was changed, cut short, moved or never encrypted. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** The organisation's keys have been shredded: its objects can no longer be read or written. */
export class TenantKeysShredded extends Error {
  constructor() {
    super("The organisation's keys have been shredded.");
    this.name = "TenantKeysShredded";
  }
}

const TENANT_IN_KEY = /^(?:dsar\/)?tenants\/([0-9a-f-]{36})\//;

/** The organisation a storage key belongs to (every storage key names one). */
export function tenantOfKey(storageKey: string): string {
  const match = TENANT_IN_KEY.exec(storageKey);
  if (!match?.[1]) throw new EnvelopeError("The storage key names no organisation.");
  return match[1];
}

export function isEnvelope(bytes: Uint8Array): boolean {
  return bytes.length >= ENVELOPE_MAGIC.length && ENVELOPE_MAGIC.equals(bytes.subarray(0, 4));
}

function nonce(prefix: Uint8Array, counter: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(prefix).copy(n, 0);
  n.writeUInt32BE(counter, PREFIX_BYTES);
  n[11] = final ? 1 : 0;
  return n;
}

function aad(header: Uint8Array, storageKey: string): Buffer {
  return Buffer.concat([header, Buffer.from(storageKey, "utf8")]);
}

function header(prefix: Uint8Array, wrapped: Uint8Array): Buffer {
  if (wrapped.length > 0xffff) throw new EnvelopeError("The wrapped key is too long.");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length, 0);
  return Buffer.concat([ENVELOPE_MAGIC, Buffer.from([VERSION]), prefix, length, wrapped]);
}

function sealSegment(
  dataKey: Uint8Array,
  prefix: Uint8Array,
  counter: number,
  final: boolean,
  plaintext: Uint8Array,
  additional: Buffer,
): Buffer {
  if (counter > 0xffffffff) throw new EnvelopeError("The object is too large.");
  const cipher = createCipheriv("aes-256-gcm", dataKey, nonce(prefix, counter, final));
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const head = Buffer.alloc(SEGMENT_HEADER);
  head[0] = final ? 1 : 0;
  head.writeUInt32BE(plaintext.length, 1);
  return Buffer.concat([head, body, cipher.getAuthTag()]);
}

function openSegment(
  dataKey: Uint8Array,
  prefix: Uint8Array,
  counter: number,
  final: boolean,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  additional: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", dataKey, nonce(prefix, counter, final));
  decipher.setAAD(additional);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EnvelopeError("The object failed its integrity check.");
  }
}

/** Unwrapped data keys, kept for a few minutes so repeated reads do not each call Cloud KMS. */
/**
 * How long an unwrapped data key is reused in one process. After a shred, another instance (or
 * the worker) may read the organisation's objects for at most this long (platform.md rule 4).
 */
export const DATA_KEY_CACHE_MS = 30_000;

export class DataKeyCache {
  private readonly entries = new Map<string, { tenantId: string; key: Buffer; expires: number }>();
  /** Bumped by `forgetTenant`: an unwrap that began before it is never cached (review M1). */
  private readonly generations = new Map<string, number>();
  private lastSweep = 0;

  constructor(
    private readonly ttlMs = DATA_KEY_CACHE_MS,
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A copy of the data key: the caller zeroes it when done; the cache zeroes its own. */
  async unwrap(keys: TenantKeyPort, tenantId: string, wrapped: Uint8Array): Promise<Buffer> {
    this.sweep();
    const id = `${tenantId}:${createHash("sha256").update(wrapped).digest("base64")}`;
    const hit = this.entries.get(id);
    if (hit && hit.expires > this.now()) return Buffer.from(hit.key);
    if (hit) this.drop(id);
    const generation = this.generations.get(tenantId) ?? 0;
    const key = Buffer.from(await keys.unwrap(tenantId, wrapped));
    if ((this.generations.get(tenantId) ?? 0) !== generation) return key;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.drop(oldest);
    }
    this.entries.set(id, { tenantId, key: Buffer.from(key), expires: this.now() + this.ttlMs });
    return key;
  }

  /** Forgets every data key of an organisation (on shred, before anything else). */
  forgetTenant(tenantId: string): void {
    this.generations.set(tenantId, (this.generations.get(tenantId) ?? 0) + 1);
    for (const [id, entry] of this.entries) {
      if (entry.tenantId === tenantId) this.drop(id);
    }
  }

  private drop(id: string): void {
    this.entries.get(id)?.key.fill(0);
    this.entries.delete(id);
  }

  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < this.ttlMs) return;
    this.lastSweep = now;
    for (const [id, entry] of this.entries) if (entry.expires <= now) this.drop(id);
  }
}

async function newObjectKey(keys: TenantKeyPort, tenantId: string) {
  const dataKey = randomBytes(32);
  const wrapped = await keys.wrap(tenantId, dataKey);
  const prefix = randomBytes(PREFIX_BYTES);
  return { dataKey, prefix, head: header(prefix, wrapped) };
}

/** Encrypts a whole object. */
export async function encryptBytes(
  keys: TenantKeyPort,
  storageKey: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of encryptStream(keys, storageKey, [plaintext]))
    chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Encrypts a stream of unknown length, one segment ahead so the last is marked final. */
export async function* encryptStream(
  keys: TenantKeyPort,
  storageKey: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const { dataKey, prefix, head } = await newObjectKey(keys, tenantOfKey(storageKey));
  const additional = aad(head, storageKey);
  yield head;
  let counter = 0;
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of source) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      // Keep at least one byte back, so the final segment is never empty unless the object is.
      while (pending.length > SEGMENT_BYTES) {
        yield sealSegment(
          dataKey,
          prefix,
          counter++,
          false,
          pending.subarray(0, SEGMENT_BYTES),
          additional,
        );
        pending = pending.subarray(SEGMENT_BYTES);
      }
    }
    yield sealSegment(dataKey, prefix, counter, true, pending, additional);
  } finally {
    dataKey.fill(0);
  }
}

/** Reads bytes from a stream as they are needed. */
class Reader {
  private buffer = Buffer.alloc(0);
  private done = false;
  private readonly iterator: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    this.iterator =
      Symbol.asyncIterator in source
        ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : (async function* () {
            yield* source as Iterable<Uint8Array>;
          })();
  }

  /** Exactly `n` bytes, or null at the end of the stream; a partial read is an error. */
  async take(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    }
    if (this.buffer.length === 0 && this.done) return null;
    if (this.buffer.length < n) throw new EnvelopeError("The object was cut short.");
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  /** The first bytes without consuming them (to tell an envelope from a legacy object). */
  async peek(n: number): Promise<Buffer> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    }
    return this.buffer.subarray(0, Math.min(n, this.buffer.length));
  }

  async *rest(): AsyncIterable<Uint8Array> {
    if (this.buffer.length > 0) yield this.buffer;
    this.buffer = Buffer.alloc(0);
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else yield next.value;
    }
  }
}

export interface DecryptOptions {
  /** Objects written before envelope encryption are returned as they are (never in production). */
  readonly legacyPlaintext?: boolean;
  readonly cache?: DataKeyCache;
}

/**
 * Reads the header and unwraps the data key now, so a refusal (shredded, tampered header, not
 * encrypted) comes before any byte is sent; the segments are then decrypted as they are read.
 */
export async function openStream(
  keys: TenantKeyPort,
  storageKey: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: DecryptOptions = {},
): Promise<AsyncIterable<Uint8Array>> {
  const tenantId = tenantOfKey(storageKey);
  const reader = new Reader(source);
  const start = await reader.peek(ENVELOPE_MAGIC.length);
  if (!(start.length === ENVELOPE_MAGIC.length && ENVELOPE_MAGIC.equals(start))) {
    if (!options.legacyPlaintext) throw new EnvelopeError("The object is not encrypted.");
    return reader.rest();
  }
  const fixed = await reader.take(HEADER_FIXED);
  if (!fixed) throw new EnvelopeError("The object was cut short.");
  if (fixed[ENVELOPE_MAGIC.length] !== VERSION)
    throw new EnvelopeError("Unknown envelope version.");
  const prefix = fixed.subarray(5, 5 + PREFIX_BYTES);
  const wrappedLength = fixed.readUInt16BE(5 + PREFIX_BYTES);
  const wrapped = await reader.take(wrappedLength);
  if (!wrapped) throw new EnvelopeError("The object was cut short.");
  const head = Buffer.concat([fixed, wrapped]);
  const additional = aad(head, storageKey);
  const dataKey = options.cache
    ? await options.cache.unwrap(keys, tenantId, wrapped)
    : Buffer.from(await keys.unwrap(tenantId, wrapped));
  return segments(reader, dataKey, prefix, additional);
}

async function* segments(
  reader: Reader,
  dataKey: Buffer,
  prefix: Buffer,
  additional: Buffer,
): AsyncIterable<Uint8Array> {
  try {
    yield* openSegments(reader, dataKey, prefix, additional);
  } finally {
    dataKey.fill(0);
  }
}

async function* openSegments(
  reader: Reader,
  dataKey: Buffer,
  prefix: Buffer,
  additional: Buffer,
): AsyncIterable<Uint8Array> {
  let counter = 0;
  for (;;) {
    const segmentHead = await reader.take(SEGMENT_HEADER);
    if (!segmentHead) throw new EnvelopeError("The object was cut short.");
    const final = segmentHead[0] === 1;
    if (segmentHead[0] !== 0 && !final)
      throw new EnvelopeError("The object failed its integrity check.");
    const length = segmentHead.readUInt32BE(1);
    if (length > SEGMENT_BYTES) throw new EnvelopeError("The object failed its integrity check.");
    const body = await reader.take(length + TAG_BYTES);
    if (!body) throw new EnvelopeError("The object was cut short.");
    yield openSegment(
      dataKey,
      prefix,
      counter++,
      final,
      body.subarray(0, length),
      body.subarray(length),
      additional,
    );
    if (final) break;
  }
  if ((await reader.take(1)) !== null)
    throw new EnvelopeError("The object has bytes after its end.");
}

/** Decrypts a stream, segment by segment. */
export async function* decryptStream(
  keys: TenantKeyPort,
  storageKey: string,
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: DecryptOptions = {},
): AsyncIterable<Uint8Array> {
  yield* await openStream(keys, storageKey, source, options);
}

export async function decryptBytes(
  keys: TenantKeyPort,
  storageKey: string,
  bytes: Uint8Array,
  options: DecryptOptions = {},
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of decryptStream(keys, storageKey, [bytes], options)) {
    chunks.push(Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * The storage port with envelope encryption in front of any adapter (Cloud Storage or local
 * disk): what reaches storage is always ciphertext under the organisation's key.
 */
export class EncryptingDocumentStorage implements DocumentStoragePort {
  readonly provider: string;
  readonly cache: DataKeyCache;

  constructor(
    private readonly inner: DocumentStoragePort,
    private readonly keys: TenantKeyPort,
    private readonly options: { readonly legacyPlaintext: boolean; readonly cache?: DataKeyCache },
  ) {
    this.provider = inner.provider;
    this.cache = options.cache ?? new DataKeyCache();
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.inner.put(key, await encryptBytes(this.keys, key, bytes), contentType);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const stored = await this.inner.get(key);
    if (!stored) return null;
    return decryptBytes(this.keys, key, stored, {
      legacyPlaintext: this.options.legacyPlaintext,
      cache: this.cache,
    });
  }

  async destroy(key: string): Promise<void> {
    await this.inner.destroy(key);
  }

  async putStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string) {
    await this.inner.putStream(key, encryptStream(this.keys, key, source), contentType);
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const stored = await this.inner.getStream(key);
    if (!stored) return null;
    return openStream(this.keys, key, stored, {
      legacyPlaintext: this.options.legacyPlaintext,
      cache: this.cache,
    });
  }

  async health(): Promise<HealthResult> {
    const [storage, keys] = await Promise.all([this.inner.health(), this.keys.health()]);
    return storage.ok && keys.ok
      ? { ok: true, detail: `${storage.detail}; keys ${keys.detail}` }
      : { ok: false, detail: storage.ok ? `keys ${keys.detail}` : storage.detail };
  }
}

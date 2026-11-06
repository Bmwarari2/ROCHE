import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DataKeyCache,
  decryptBytes,
  decryptStream,
  EncryptingDocumentStorage,
  EnvelopeError,
  encryptBytes,
  encryptStream,
  isEnvelope,
  SEGMENT_BYTES,
  TenantKeysShredded,
  tenantOfKey,
} from "./envelope";
import { LocalDocumentStorage } from "./storage";
import { LocalTenantKeys } from "./tenant-keys";

/** Envelope encryption (PLAT-012, ADR-0109): round trips, tampering, truncation, shredding. */

const A = "0194d000-0000-7000-8000-00000000000a";
const B = "0194d000-0000-7000-8000-00000000000b";
const docKey = (tenant: string, id = "0194d000-0000-7000-8000-0000000000d1") =>
  `tenants/${tenant}/documents/${id}`;

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of source) parts.push(Buffer.from(p));
  return Buffer.concat(parts);
}

describe("envelope round trips", () => {
  it.each([
    ["empty", 0],
    ["one byte", 1],
    ["one segment exactly", SEGMENT_BYTES],
    ["just over a segment", SEGMENT_BYTES + 1],
    ["several segments", SEGMENT_BYTES * 3 + 17],
  ])("%s (%i bytes)", async (_name, size) => {
    const keys = new LocalTenantKeys();
    const plain = randomBytes(size);
    const sealed = await encryptBytes(keys, docKey(A), plain);
    expect(isEnvelope(sealed)).toBe(true);
    if (size >= 16) expect(Buffer.from(sealed).includes(plain.subarray(0, 16))).toBe(false);
    expect(Buffer.from(await decryptBytes(keys, docKey(A), sealed))).toEqual(plain);
  });

  it("streams in and out in uneven chunks", async () => {
    const keys = new LocalTenantKeys();
    const plain = randomBytes(SEGMENT_BYTES * 2 + 999);
    async function* chunks() {
      for (let i = 0; i < plain.length; i += 7777) yield plain.subarray(i, i + 7777);
    }
    const sealed = await collect(encryptStream(keys, docKey(A), chunks()));
    async function* sealedChunks() {
      for (let i = 0; i < sealed.length; i += 1000) yield sealed.subarray(i, i + 1000);
    }
    expect(await collect(decryptStream(keys, docKey(A), sealedChunks()))).toEqual(plain);
  });

  it("gives every object its own data key and nonce", async () => {
    const keys = new LocalTenantKeys();
    const plain = Buffer.from("same bytes");
    const one = Buffer.from(await encryptBytes(keys, docKey(A), plain));
    const two = Buffer.from(await encryptBytes(keys, docKey(A), plain));
    expect(one.equals(two)).toBe(false);
  });
});

const flip = (b: Buffer, at: number) => b.writeUInt8(b.readUInt8(at) ^ 0x01, at);

describe("envelope refusals", () => {
  const plain = randomBytes(SEGMENT_BYTES + 100);

  async function sealed() {
    const keys = new LocalTenantKeys();
    return { keys, bytes: Buffer.from(await encryptBytes(keys, docKey(A), plain)) };
  }

  it.each([
    ["a changed header byte", (b: Buffer) => flip(b, 6)],
    ["a changed ciphertext byte", (b: Buffer) => flip(b, b.length - 40)],
    ["a changed tag byte", (b: Buffer) => flip(b, b.length - 1)],
    [
      "a flipped final flag",
      (b: Buffer) => {
        const wrappedLength = b.readUInt16BE(12);
        b[14 + wrappedLength] = 1;
      },
    ],
  ])("refuses %s", async (_name, change) => {
    const { keys, bytes } = await sealed();
    change(bytes);
    await expect(decryptBytes(keys, docKey(A), bytes)).rejects.toBeInstanceOf(EnvelopeError);
  });

  it("refuses an object cut short, or with bytes after its end", async () => {
    const { keys, bytes } = await sealed();
    await expect(
      decryptBytes(keys, docKey(A), bytes.subarray(0, bytes.length - 1)),
    ).rejects.toThrow(EnvelopeError);
    const head = 14 + bytes.readUInt16BE(12);
    await expect(
      decryptBytes(keys, docKey(A), bytes.subarray(0, head + 5 + SEGMENT_BYTES + 16)),
    ).rejects.toThrow(/cut short/);
    await expect(
      decryptBytes(keys, docKey(A), Buffer.concat([bytes, Buffer.from([0])])),
    ).rejects.toThrow(/after its end/);
  });

  it("refuses an object moved to another storage key", async () => {
    const { keys, bytes } = await sealed();
    await expect(
      decryptBytes(keys, docKey(A, "0194d000-0000-7000-8000-0000000000d2"), bytes),
    ).rejects.toThrow(EnvelopeError);
  });

  it("refuses an object of one organisation read as another's", async () => {
    const keys = new LocalTenantKeys();
    const sealedA = await encryptBytes(keys, docKey(A), plain);
    await encryptBytes(keys, docKey(B), plain);
    await expect(decryptBytes(keys, docKey(B), sealedA)).rejects.toThrow(EnvelopeError);
  });

  it("refuses plain bytes unless legacy reading is allowed", async () => {
    const keys = new LocalTenantKeys();
    await expect(decryptBytes(keys, docKey(A), Buffer.from("plain"))).rejects.toThrow(
      /not encrypted/,
    );
    expect(
      Buffer.from(
        await decryptBytes(keys, docKey(A), Buffer.from("plain"), { legacyPlaintext: true }),
      ).toString(),
    ).toBe("plain");
  });

  it.each(["documents/x", "tenants/not-a-uuid/documents/x", ""])(
    "refuses a key that names no organisation: %j",
    (key) => {
      expect(() => tenantOfKey(key)).toThrow(EnvelopeError);
    },
  );

  it("reads the organisation from document, export and DSAR keys", () => {
    expect(tenantOfKey(`tenants/${A}/exports/${B}/export.zip`)).toBe(A);
    expect(tenantOfKey(`dsar/tenants/${A}/${B}/${B}.json`)).toBe(A);
  });
});

describe("shredding", () => {
  it("makes every object of the organisation unreadable, and only that organisation's", async () => {
    const keys = new LocalTenantKeys();
    const sealedA = await encryptBytes(keys, docKey(A), Buffer.from("a"));
    const sealedB = await encryptBytes(keys, docKey(B), Buffer.from("b"));
    const destroyed = await keys.shred(A);
    expect(destroyed.length).toBeGreaterThan(0);
    await expect(decryptBytes(keys, docKey(A), sealedA)).rejects.toBeInstanceOf(TenantKeysShredded);
    await expect(encryptBytes(keys, docKey(A), Buffer.from("again"))).rejects.toBeInstanceOf(
      TenantKeysShredded,
    );
    expect(Buffer.from(await decryptBytes(keys, docKey(B), sealedB)).toString()).toBe("b");
  });

  it("refuses a streamed read before any byte is sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "harbour-envelope-"));
    try {
      const keys = new LocalTenantKeys();
      const storage = new EncryptingDocumentStorage(new LocalDocumentStorage(root), keys, {
        legacyPlaintext: false,
      });
      await storage.put(docKey(A), Buffer.from("a"), "text/plain");
      await keys.shred(A);
      storage.cache.forgetTenant(A);
      await expect(storage.getStream(docKey(A))).rejects.toBeInstanceOf(TenantKeysShredded);
      await expect(storage.get(docKey(A))).rejects.toBeInstanceOf(TenantKeysShredded);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses reads at once even while destruction is only scheduled", async () => {
    let now = new Date("2026-10-31T12:00:00Z");
    const keys = new LocalTenantKeys({ destroyDelayMs: 30 * 86_400_000, now: () => now });
    const sealed = await encryptBytes(keys, docKey(A), Buffer.from("a"));
    const [version] = await keys.shred(A);
    expect(version?.destroyAt).toBe("2026-11-30T12:00:00.000Z");
    await expect(decryptBytes(keys, docKey(A), sealed)).rejects.toBeInstanceOf(TenantKeysShredded);
    now = new Date("2026-12-01T00:00:00Z");
    await expect(decryptBytes(keys, docKey(A), sealed)).rejects.toBeInstanceOf(TenantKeysShredded);
  });

  it("drops cached data keys when told, so a cached key cannot outlive the shred", async () => {
    const keys = new LocalTenantKeys();
    const cache = new DataKeyCache();
    const sealed = await encryptBytes(keys, docKey(A), Buffer.from("a"));
    await decryptBytes(keys, docKey(A), sealed, { cache });
    await keys.shred(A);
    expect(Buffer.from(await decryptBytes(keys, docKey(A), sealed, { cache })).toString()).toBe(
      "a",
    );
    cache.forgetTenant(A);
    await expect(decryptBytes(keys, docKey(A), sealed, { cache })).rejects.toBeInstanceOf(
      TenantKeysShredded,
    );
  });

  it("never caches a key whose unwrap finished after the shred was forgotten (review M1)", async () => {
    const keys = new LocalTenantKeys();
    const cache = new DataKeyCache();
    const sealed = await encryptBytes(keys, docKey(A), Buffer.from("a"));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = Object.assign(Object.create(keys) as LocalTenantKeys, {
      unwrap: async (tenant: string, wrapped: Uint8Array) => {
        const key = await keys.unwrap(tenant, wrapped);
        await gate;
        return key;
      },
    });
    const inFlight = decryptBytes(slow, docKey(A), sealed, { cache });
    await new Promise((r) => setTimeout(r, 10));
    await keys.shred(A);
    cache.forgetTenant(A);
    release();
    expect(Buffer.from(await inFlight).toString()).toBe("a");
    await expect(decryptBytes(keys, docKey(A), sealed, { cache })).rejects.toBeInstanceOf(
      TenantKeysShredded,
    );
  });

  it("expires cached keys", async () => {
    let t = 0;
    const keys = new LocalTenantKeys();
    const cache = new DataKeyCache(1000, 10, () => t);
    const sealed = await encryptBytes(keys, docKey(A), Buffer.from("a"));
    await decryptBytes(keys, docKey(A), sealed, { cache });
    await keys.shred(A);
    t = 2000;
    await expect(decryptBytes(keys, docKey(A), sealed, { cache })).rejects.toBeInstanceOf(
      TenantKeysShredded,
    );
  });
});

describe("EncryptingDocumentStorage over local disk", () => {
  it("stores only ciphertext and reads it back, whole and streamed", async () => {
    const root = mkdtempSync(join(tmpdir(), "harbour-envelope-"));
    try {
      const inner = new LocalDocumentStorage(root);
      const keys = new LocalTenantKeys({ dir: join(root, "keys") });
      const storage = new EncryptingDocumentStorage(inner, keys, { legacyPlaintext: false });
      const plain = Buffer.from("%PDF-1.7 Ada Example's care plan");
      await storage.put(docKey(A), plain, "application/pdf");
      const raw = Buffer.from((await inner.get(docKey(A))) ?? []);
      expect(isEnvelope(raw)).toBe(true);
      expect(raw.includes(Buffer.from("Ada Example"))).toBe(false);
      expect(Buffer.from((await storage.get(docKey(A))) ?? [])).toEqual(plain);
      const exportKey = `tenants/${A}/exports/${B}/export.zip`;
      await storage.putStream(
        exportKey,
        (async function* () {
          yield plain;
          yield plain;
        })(),
        "application/zip",
      );
      const back = await storage.getStream(exportKey);
      expect(await collect(back as AsyncIterable<Uint8Array>)).toEqual(
        Buffer.concat([plain, plain]),
      );
      expect(await storage.get(`tenants/${A}/documents/${B}`)).toBeNull();
      // A second provider on the same directory (the worker) reads what the first wrote.
      const worker = new EncryptingDocumentStorage(
        inner,
        new LocalTenantKeys({ dir: join(root, "keys") }),
        {
          legacyPlaintext: false,
        },
      );
      expect(Buffer.from((await worker.get(docKey(A))) ?? [])).toEqual(plain);
      expect((await storage.health()).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

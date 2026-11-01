import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { DocumentStoragePort } from "@harbour/domain";
import { afterAll, describe, expect, it } from "vitest";
import {
  type GcsBucket,
  GcsDocumentStorage,
  LocalDocumentStorage,
  StorageDeleteFailed,
} from "./storage";

/**
 * The document storage port's contract, run against local disk and against the Cloud Storage
 * adapter (ADR-0098), whose bucket is an in-memory double of the SDK's `Bucket`: no network, no
 * real cloud service. The double keeps generations as a versioned bucket does, records every
 * write's options, and can be told to fail deletions.
 */

const TENANT = "0194d000-0000-7000-8000-000000000001";
const KEY = `tenants/${TENANT}/documents/0194d000-0000-7000-8600-0000000000aa`;
const OTHER = `${KEY.slice(0, -2)}bb`;
const EXPORT_KEY = `tenants/${TENANT}/exports/0194d000-0000-7000-8700-0000000000cc/export.zip`;
const KMS_KEY = "projects/harbour-test/locations/europe-west2/keyRings/harbour/cryptoKeys/storage";

interface Stored {
  generation: number;
  bytes: Buffer;
  metadata: Record<string, unknown>;
}

interface Write {
  readonly key: string;
  readonly kmsKeyName: string | undefined;
  readonly options: Record<string, unknown>;
}

function notFound(): Error {
  return Object.assign(new Error("No such object"), { code: 404 });
}

interface BucketDouble {
  bucket: GcsBucket;
  readonly objects: Map<string, Stored[]>;
  readonly writes: Write[];
  readonly deleted: string[];
  /** A deletion of a generation in this set fails with 403. */
  readonly refuse: Set<string>;
  /** Generations listed again after every deletion (a bucket that keeps them). */
  sticky: boolean;
  metadata: Record<string, unknown>;
}

function bucketDouble(): BucketDouble {
  const objects = new Map<string, Stored[]>();
  const writes: Write[] = [];
  const deleted: string[] = [];
  const refuse = new Set<string>();
  let next = 1;
  const double: BucketDouble = {
    objects,
    writes,
    deleted,
    refuse,
    sticky: false,
    metadata: {
      location: "EUROPE-WEST2",
      encryption: { defaultKmsKeyName: KMS_KEY },
      softDeletePolicy: { retentionDurationSeconds: "0" },
    },
    bucket: undefined as unknown as GcsBucket,
  };
  const store = (key: string, bytes: Buffer, options: Record<string, unknown>) => {
    const metadata = (options.metadata ?? {}) as Record<string, unknown>;
    objects.set(key, [...(objects.get(key) ?? []), { generation: next++, bytes, metadata }]);
  };
  const latest = (key: string) => objects.get(key)?.at(-1);
  const file = (key: string, options: { kmsKeyName?: string; generation?: string } = {}) => ({
    name: key,
    async save(bytes: Buffer, saveOptions: Record<string, unknown>) {
      writes.push({ key, kmsKeyName: options.kmsKeyName, options: saveOptions });
      store(key, Buffer.from(bytes), saveOptions);
    },
    async download() {
      const found = latest(key);
      if (!found) throw notFound();
      return [Buffer.from(found.bytes)];
    },
    async exists() {
      return [Boolean(latest(key))];
    },
    createReadStream() {
      const found = latest(key);
      return Readable.from(found ? [found.bytes] : []);
    },
    createWriteStream(writeOptions: Record<string, unknown>) {
      writes.push({ key, kmsKeyName: options.kmsKeyName, options: writeOptions });
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on("data", (chunk: Buffer) => chunks.push(chunk));
      // Finalised only when the whole stream arrived, as a resumable upload is.
      sink.on("end", () => store(key, Buffer.concat(chunks), writeOptions));
      return sink;
    },
    async delete() {
      const generation = options.generation;
      if (generation && refuse.has(generation)) {
        throw Object.assign(new Error(`Forbidden: ${key}`), { code: 403 });
      }
      deleted.push(generation ?? "live");
      if (double.sticky) return;
      const left = (objects.get(key) ?? []).filter((o) => String(o.generation) !== generation);
      if (left.length === (objects.get(key) ?? []).length) throw notFound();
      if (left.length > 0) objects.set(key, left);
      else objects.delete(key);
    },
  });
  double.bucket = {
    file,
    async getFiles(query: { prefix?: string; versions?: boolean }) {
      const files = [...objects.entries()]
        .filter(([name]) => name.startsWith(query.prefix ?? ""))
        .flatMap(([name, versions]) =>
          (query.versions ? versions : versions.slice(-1)).map((v) => ({
            name,
            metadata: { generation: String(v.generation) },
          })),
        );
      return [files];
    },
    async getMetadata() {
      return [double.metadata];
    },
  } as unknown as GcsBucket;
  return double;
}

async function readAll(source: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const adapters: [string, () => Promise<DocumentStoragePort>][] = [
  [
    "local disk",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "harbour-storage-"));
      roots.push(root);
      return new LocalDocumentStorage(root);
    },
  ],
  ["Cloud Storage", async () => new GcsDocumentStorage(bucketDouble().bucket, KMS_KEY)],
];

describe.each(adapters)("DocumentStoragePort contract: %s", (_name, make) => {
  it("reads back what was put, and nothing for a key never written", async () => {
    const storage = await make();
    await storage.put(KEY, new TextEncoder().encode("first"), "application/pdf");
    expect(new TextDecoder().decode((await storage.get(KEY)) ?? undefined)).toBe("first");
    expect(await storage.get(OTHER)).toBeNull();
    expect(await storage.getStream(OTHER)).toBeNull();
  });

  it("streams an object of unknown length in and out", async () => {
    const storage = await make();
    await storage.putStream(EXPORT_KEY, chunks("part one, ", "part two"), "application/zip");
    const stream = await storage.getStream(EXPORT_KEY);
    expect(stream).not.toBeNull();
    expect(await readAll(stream as AsyncIterable<Uint8Array>)).toBe("part one, part two");
  });

  it("destroys an object, leaving the others", async () => {
    const storage = await make();
    await storage.put(KEY, new Uint8Array([1]), "image/png");
    await storage.put(KEY, new Uint8Array([2]), "image/png");
    await storage.put(OTHER, new Uint8Array([3]), "image/png");
    await storage.destroy(KEY);
    await storage.destroy(KEY);
    expect(await storage.get(KEY)).toBeNull();
    expect(await storage.get(OTHER)).toEqual(new Uint8Array([3]));
  });

  it.each([
    "tenants/../etc/passwd",
    "tenants/not-a-uuid/documents/x",
    `${KEY}/../../secret`,
    "Ada Example.pdf",
  ])("refuses the key %s", async (key) => {
    const storage = await make();
    await expect(storage.put(key, new Uint8Array([1]), "application/pdf")).rejects.toThrow(
      "Invalid storage key",
    );
    await expect(storage.get(key)).rejects.toThrow("Invalid storage key");
    await expect(storage.destroy(key)).rejects.toThrow("Invalid storage key");
  });

  it("reports healthy when its store is ready", async () => {
    expect((await (await make()).health()).ok).toBe(true);
  });
});

describe("GcsDocumentStorage writes (ADR-0098)", () => {
  it("names the customer-managed key and keeps only the content type as metadata", async () => {
    const double = bucketDouble();
    const storage = new GcsDocumentStorage(double.bucket, KMS_KEY);
    await storage.put(KEY, new Uint8Array([1]), "application/pdf");
    await storage.putStream(EXPORT_KEY, chunks("zip"), "application/zip");
    expect(double.writes.map((w) => w.kmsKeyName)).toEqual([KMS_KEY, KMS_KEY]);
    for (const write of double.writes) {
      expect(write.options.metadata).toEqual({ contentType: write.options.contentType });
      expect(Object.keys(write.options)).not.toContain("contentDisposition");
      expect(write.options.validation).toBe("crc32c");
    }
    expect(double.writes[1]?.options.resumable).toBe(true);
  });

  it("leaves no object when a streamed upload fails part way", async () => {
    const double = bucketDouble();
    const storage = new GcsDocumentStorage(double.bucket, KMS_KEY);
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error("source failed");
    }
    await expect(storage.putStream(EXPORT_KEY, failing(), "application/zip")).rejects.toThrow(
      "source failed",
    );
    expect(double.objects.has(EXPORT_KEY)).toBe(false);
  });
});

/**
 * Deletion past retention (security review of #134, M2): a deletion counts only when every
 * generation went and the key has none left.
 */
describe("GcsDocumentStorage.destroy", () => {
  async function stored(versions: number) {
    const double = bucketDouble();
    const storage = new GcsDocumentStorage(double.bucket, KMS_KEY);
    for (let i = 0; i < versions; i += 1) await storage.put(KEY, new Uint8Array([i]), "image/png");
    await storage.put(OTHER, new Uint8Array([9]), "image/png");
    return { double, storage };
  }

  it("deletes every generation of the key, never another key's", async () => {
    const { double, storage } = await stored(2);
    await storage.destroy(KEY);
    expect(double.deleted).toEqual(["1", "2"]);
    expect(double.objects.has(KEY)).toBe(false);
    expect(double.objects.has(OTHER)).toBe(true);
  });

  it("throws when a generation cannot be deleted, so the retry goes on", async () => {
    const { double, storage } = await stored(2);
    double.refuse.add("2");
    const failure = await storage.destroy(KEY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageDeleteFailed);
    expect(failure).toMatchObject({ name: "StorageDeleteFailed", code: "403", count: 1 });
    // Only the error code is kept: never the key or the message.
    expect(JSON.stringify(failure)).not.toContain(KEY);
    expect(String((failure as Error).message)).not.toContain(KEY);
  });

  it("throws when a generation is still listed after the delete", async () => {
    const { double, storage } = await stored(1);
    double.sticky = true;
    await expect(storage.destroy(KEY)).rejects.toMatchObject({
      code: "VersionsRemain",
      count: 1,
    });
  });

  it("does nothing, and succeeds, when the key has no generation left", async () => {
    const { double, storage } = await stored(0);
    await storage.destroy(KEY);
    expect(double.deleted).toEqual([]);
  });
});

describe("GcsDocumentStorage.health (ADR-0098: europe-west2, CMEK, no soft delete)", () => {
  it.each([
    ["another region", { location: "EUROPE-WEST1" }, "europe-west2"],
    ["a multi-region", { location: "EU" }, "europe-west2"],
    ["Google-managed encryption", { encryption: undefined }, "key"],
    ["another key", { encryption: { defaultKmsKeyName: `${KMS_KEY.slice(0, -7)}other` } }, "key"],
    [
      "soft-deleted copies kept",
      { softDeletePolicy: { retentionDurationSeconds: "604800" } },
      "soft-deleted",
    ],
  ])("is unhealthy with %s", async (_label, change, detail) => {
    const double = bucketDouble();
    double.metadata = { ...double.metadata, ...change };
    const health = await new GcsDocumentStorage(double.bucket, KMS_KEY).health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain(detail);
  });

  it("is unhealthy, with the error code only, when the bucket cannot be read", async () => {
    const bucket = {
      getMetadata: async () => {
        throw Object.assign(new Error("Permission denied on harbour-docs"), { code: 403 });
      },
    } as unknown as GcsBucket;
    expect(await new GcsDocumentStorage(bucket, KMS_KEY).health()).toEqual({
      ok: false,
      detail: "unreachable (403)",
    });
  });
});

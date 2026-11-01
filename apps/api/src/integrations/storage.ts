import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Bucket } from "@google-cloud/storage";
import { Storage } from "@google-cloud/storage";
import type {
  DocumentStoragePort,
  HealthResult,
  MalwareScanPort,
  MalwareVerdict,
} from "@harbour/domain";

/**
 * Document storage and malware scanning adapters (section 9.1, ASVS V5). Local disk for development
 * and tests; Cloud Storage in europe-west2 (CMEK by bucket default, ADR-0098) in Google Cloud;
 * ClamAV over its INSTREAM protocol; a mock scanner that recognises the EICAR test file for tests.
 */

/** The only Google Cloud location personal data may be stored in (ADR-0098). */
export const ALLOWED_GCS_LOCATIONS: readonly string[] = ["EUROPE-WEST2"];

/**
 * A document's bytes, an export's archive (`exportStoragePrefix` plus `export.zip`), or an issued
 * DSAR bundle (`dsarBundleStorageKey`, #149 M3), or an issued disclosure pack
 * (`disclosurePackStorageKey`, SAFE-016).
 */
const KEY_PATTERN =
  /^(tenants\/[0-9a-f-]{36}\/(documents\/[0-9a-f-]{36}|exports\/[0-9a-f-]{36}\/export\.zip|disclosures\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json)|dsar\/tenants\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json)$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
}

export class LocalDocumentStorage implements DocumentStoragePort {
  readonly provider = "local";
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    assertKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async destroy(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async putStream(key: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await pipeline(Readable.from(source), createWriteStream(path, { mode: 0o600 }));
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const path = this.path(key);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return createReadStream(path);
  }

  async health(): Promise<HealthResult> {
    await mkdir(this.root, { recursive: true });
    return { ok: true, detail: "local disk" };
  }
}

/**
 * Stored bytes that could not be deleted. `code` is Cloud Storage's error code for the first object
 * (or `VersionsRemain`), which the worker logs; never the key or anything else about the object.
 */
export class StorageDeleteFailed extends Error {
  constructor(
    readonly code: string,
    readonly count: number,
  ) {
    super("Stored versions could not be deleted.");
    this.name = "StorageDeleteFailed";
  }
}

/** What the adapter uses of a Cloud Storage bucket: the SDK's `Bucket`, or a double in tests. */
export type GcsBucket = Pick<Bucket, "file" | "getFiles" | "getMetadata">;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" || typeof code === "string" ? String(code) : "DeleteError";
}

function notFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 404;
}

/**
 * Cloud Storage in europe-west2 (ADR-0098). Each object is written under the bucket's customer-
 * managed key, named again on every write; the only object metadata is the content type (no file
 * name, title or anything else that could identify a person). The bucket keeps generations, so
 * destruction deletes every one of them.
 */
export class GcsDocumentStorage implements DocumentStoragePort {
  readonly provider = "gcs";

  constructor(
    private readonly bucket: GcsBucket,
    private readonly kmsKeyName: string,
  ) {}

  /** The adapter for a named bucket; the client finds its credentials in the environment. */
  static forBucket(projectId: string, bucket: string, kmsKeyName: string): GcsDocumentStorage {
    return new GcsDocumentStorage(new Storage({ projectId }).bucket(bucket), kmsKeyName);
  }

  private file(key: string) {
    assertKey(key);
    return this.bucket.file(key, { kmsKeyName: this.kmsKeyName });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.file(key).save(Buffer.from(bytes), {
      resumable: false,
      contentType,
      metadata: { contentType },
      validation: "crc32c",
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const [bytes] = await this.file(key).download();
      return new Uint8Array(bytes);
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  /**
   * Writes a stream of unknown length as a resumable upload, which holds one chunk in memory at a
   * time. An upload that fails is never finalised, so no partial object is left.
   */
  async putStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string) {
    const target = this.file(key).createWriteStream({
      resumable: true,
      contentType,
      metadata: { contentType },
      validation: "crc32c",
    });
    await pipeline(Readable.from(source), target);
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const file = this.file(key);
    const [exists] = await file.exists();
    return exists ? file.createReadStream() : null;
  }

  /**
   * Deletes every generation of the key, so nothing survives destruction in a versioned bucket.
   * Any generation that cannot be deleted throws, and the generations are listed again afterwards,
   * so anything still there throws too. The caller's retry then goes on until the key is empty
   * (security review of #134, M2).
   */
  async destroy(key: string): Promise<void> {
    assertKey(key);
    const generations = await this.generationsOf(key);
    let failed = 0;
    let firstCode: string | null = null;
    for (const generation of generations) {
      try {
        await this.bucket.file(key, { generation }).delete();
      } catch (error) {
        if (notFound(error)) continue;
        failed += 1;
        firstCode ??= errorCode(error);
      }
    }
    if (failed > 0) throw new StorageDeleteFailed(firstCode ?? "DeleteError", failed);
    const left = await this.generationsOf(key);
    if (left.length > 0) throw new StorageDeleteFailed("VersionsRemain", left.length);
  }

  /** Every generation stored under exactly this key, live or noncurrent. */
  private async generationsOf(key: string): Promise<string[]> {
    const [files] = await this.bucket.getFiles({ prefix: key, versions: true, autoPaginate: true });
    return files
      .filter((f) => f.name === key && f.metadata.generation !== undefined)
      .map((f) => String(f.metadata.generation));
  }

  /**
   * Healthy only when the bucket is reachable, in europe-west2, encrypted by default with the
   * configured key, and keeps no soft-deleted copies (which would outlive destruction).
   */
  async health(): Promise<HealthResult> {
    try {
      const [metadata] = await this.bucket.getMetadata();
      if (!ALLOWED_GCS_LOCATIONS.includes(String(metadata.location ?? "").toUpperCase())) {
        return { ok: false, detail: "bucket outside europe-west2" };
      }
      if (metadata.encryption?.defaultKmsKeyName !== this.kmsKeyName) {
        return { ok: false, detail: "bucket default key is not the configured key" };
      }
      if (Number(metadata.softDeletePolicy?.retentionDurationSeconds ?? 0) > 0) {
        return { ok: false, detail: "bucket keeps soft-deleted objects" };
      }
      return { ok: true, detail: "bucket reachable" };
    } catch (error) {
      return { ok: false, detail: `unreachable (${errorCode(error)})` };
    }
  }
}

/** The standard anti-virus test string (not malware); scanners must flag it. */
export const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export class MockMalwareScanner implements MalwareScanPort {
  readonly provider = "mock";

  async scan(bytes: Uint8Array): Promise<MalwareVerdict> {
    return Buffer.from(bytes).includes(EICAR) ? "infected" : "clean";
  }
}

/**
 * ClamAV daemon client (INSTREAM). Any failure is `unavailable`, which keeps the upload
 * quarantined rather than serving an unscanned file.
 */
export class ClamdScanner implements MalwareScanPort {
  readonly provider = "clamd";

  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(bytes: Uint8Array): Promise<MalwareVerdict> {
    return new Promise((done) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      const finish = (verdict: MalwareVerdict) => {
        socket.destroy();
        done(verdict);
      };
      socket.setTimeout(this.timeoutMs, () => finish("unavailable"));
      socket.on("error", () => finish("unavailable"));
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("end", () => {
        const reply = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
        if (reply.endsWith("OK")) finish("clean");
        else if (reply.endsWith("FOUND")) finish("infected");
        else finish("unavailable");
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        const size = Buffer.alloc(4);
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
          const chunk = bytes.subarray(offset, offset + 64 * 1024);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(Buffer.from(size));
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
    });
  }
}

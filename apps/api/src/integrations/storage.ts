import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type {
  DocumentStoragePort,
  HealthResult,
  MalwareScanPort,
  MalwareVerdict,
} from "@harbour/domain";

/**
 * Document storage and malware scanning adapters (section 9.1, ASVS V5). Local disk for development
 * and tests; S3 (SSE-KMS by bucket default, versioned) in AWS; ClamAV over its INSTREAM protocol
 * in AWS; a mock scanner that recognises the EICAR test file for tests.
 */

/** S3 multipart parts (the minimum is 5 MiB): the most of an export held in memory at once. */
const PART_BYTES = 8 * 1024 * 1024;

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

  async getRange(key: string, start: number, end: number) {
    const path = this.path(key);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return createReadStream(path, { start, end });
  }

  async health(): Promise<HealthResult> {
    await mkdir(this.root, { recursive: true });
    return { ok: true, detail: "local disk" };
  }
}

/**
 * Stored bytes that could not be deleted. `code` is S3's error code for the first object (or
 * `VersionsRemain`), which the worker logs; never the key or anything else about the object.
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

export class S3DocumentStorage implements DocumentStoragePort {
  readonly provider = "s3";

  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // Bucket default encryption is SSE-KMS (infra); ask for it explicitly as well.
        ServerSideEncryption: "aws:kms",
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return result.Body ? new Uint8Array(await result.Body.transformToByteArray()) : null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  /**
   * Writes a stream of unknown length as a multipart upload in parts of `PART_BYTES`, so at most
   * one part is held in memory; SSE-KMS as for every object. A failed upload is aborted.
   */
  async putStream(key: string, source: AsyncIterable<Uint8Array>, contentType: string) {
    assertKey(key);
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ServerSideEncryption: "aws:kms",
      }),
    );
    const parts: { ETag: string | undefined; PartNumber: number }[] = [];
    const upload = async (body: Buffer) => {
      const PartNumber = parts.length + 1;
      const { ETag } = await this.client.send(
        new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId, PartNumber, Body: body }),
      );
      parts.push({ ETag, PartNumber });
    };
    try {
      let pending: Buffer[] = [];
      let size = 0;
      for await (const chunk of source) {
        pending.push(Buffer.from(chunk));
        size += chunk.length;
        if (size >= PART_BYTES) {
          await upload(Buffer.concat(pending));
          pending = [];
          size = 0;
        }
      }
      if (size > 0 || parts.length === 0) await upload(Buffer.concat(pending));
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (error) {
      await this.client
        .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId }))
        .catch(() => undefined);
      throw error;
    }
  }

  async getStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    assertKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return (result.Body as AsyncIterable<Uint8Array> | undefined) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async getRange(key: string, start: number, end: number) {
    assertKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
      );
      return (result.Body as AsyncIterable<Uint8Array> | undefined) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  /**
   * Deletes every version and delete marker, so nothing survives destruction in a versioned bucket.
   * A batch delete answers 200 with the objects it could not delete in `Errors` (Quiet only leaves
   * out the ones it did), so any error throws; and the versions are listed again afterwards, so
   * anything still there throws too. The caller's retry then goes on until the key is empty
   * (security review of #134, M2).
   */
  async destroy(key: string): Promise<void> {
    assertKey(key);
    const versions = await this.versionsOf(key);
    // DeleteObjects takes at most 1,000 objects.
    for (let at = 0; at < versions.length; at += 1000) {
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: versions.slice(at, at + 1000), Quiet: true },
        }),
      );
      const failed = result.Errors ?? [];
      if (failed.length > 0) {
        throw new StorageDeleteFailed(failed[0]?.Code ?? "DeleteObjectsError", failed.length);
      }
    }
    const left = await this.versionsOf(key);
    if (left.length > 0) throw new StorageDeleteFailed("VersionsRemain", left.length);
  }

  /** Every version and delete marker stored under exactly this key. */
  private async versionsOf(key: string): Promise<{ Key: string; VersionId: string }[]> {
    const found: { Key: string; VersionId: string }[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      for (const v of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
        if (v.Key === key && v.VersionId) found.push({ Key: key, VersionId: v.VersionId });
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
    return found;
  }

  async health(): Promise<HealthResult> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true, detail: "bucket reachable" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.name : "unreachable" };
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

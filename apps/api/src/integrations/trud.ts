import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type DmdLoadLimits, readDmdReleaseDirectory } from "@harbour/db/dmd";
import {
  checkTrudRelease,
  type DmdReleaseFiles,
  type DmdReleaseSourcePort,
  dmdArchiveEntryName,
  type HealthResult,
  type TrudProblemCode,
  type TrudRelease,
  trudUrlAllowed,
} from "@harbour/domain";
import yauzl from "yauzl";

/**
 * The TRUD adapter for the dm+d release source port (integrations.md section 11, "Release
 * download"; slice 75; ADR-0080; HZ-113). It asks TRUD for the latest NHSBSA dm+d release, refuses
 * an answer that does not name a dated archive on TRUD's own host with its size and SHA-256,
 * streams the archive into a private directory checking both, unpacks only plain XML file names
 * (and zips nested one level) within the loader's limits, and hands the directory to the same
 * reader a manual run uses. The API key is in the request path only: errors carry a code and an
 * HTTP status, never an address.
 */

export class TrudError extends Error {
  constructor(
    readonly code: TrudProblemCode,
    readonly status?: number,
  ) {
    super(`The dm+d download stopped: ${code}${status === undefined ? "" : ` (HTTP ${status})`}.`);
    this.name = "TrudError";
  }
}

/** The fetch the adapter uses; a test passes its own. Redirects are always followed by hand. */
export type TrudFetch = typeof fetch;

export interface TrudOptions {
  readonly apiKey: string;
  readonly item: number;
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  /** Plain HTTP on the allowed hosts: tests against a mock TRUD only. */
  readonly allowHttp?: boolean;
  readonly workDir?: string;
  readonly limits: Pick<DmdLoadLimits, "maxFiles" | "maxBytes"> & {
    readonly maxArchiveBytes: number;
  };
  /** How long one request may take, the archive's download included. */
  readonly timeoutMs: number;
  readonly fetch?: TrudFetch;
}

const MAX_REDIRECTS = 3;
const MAX_ANSWER_BYTES = 1024 * 1024;

export class TrudDmdReleaseSource implements DmdReleaseSourcePort {
  readonly provider = "trud";
  private described: TrudRelease | null = null;
  private directory: string | null = null;

  constructor(private readonly options: TrudOptions) {}

  private allowed(url: string): boolean {
    return trudUrlAllowed(url, this.options.allowedHosts, {
      allowHttp: this.options.allowHttp === true,
    });
  }

  /** One GET, following at most three redirects, each to an allowed address. */
  private async get(url: string, signal: AbortSignal): Promise<Response> {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (!this.allowed(current)) throw new TrudError("trud_response_invalid");
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(current, {
          redirect: "manual",
          signal,
          headers: { accept: "application/json, application/zip, application/octet-stream" },
        });
      } catch {
        // The error's message may hold the address, and so the key: only the code is kept.
        throw new TrudError("trud_unreachable");
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || hop >= MAX_REDIRECTS) throw new TrudError("trud_refused", response.status);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TrudError("trud_refused", response.status);
      }
      return response;
    }
  }

  async peek(): Promise<{ name: string; releasedOn: string } | null> {
    const release = await this.describe();
    return { name: release.name, releasedOn: release.releasedOn };
  }

  /** TRUD's latest release, checked (rule 1); asked once per run. */
  private async describe(): Promise<TrudRelease> {
    if (this.described) return this.described;
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const url = `${base}/keys/${encodeURIComponent(this.options.apiKey)}/items/${this.options.item}/releases?latest`;
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    const response = await this.get(url, signal);
    const text = await readLimited(response, MAX_ANSWER_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TrudError("trud_response_invalid");
    }
    const verdict = checkTrudRelease(
      body,
      {
        maxArchiveBytes: this.options.limits.maxArchiveBytes,
        allowedHosts: this.options.allowedHosts,
      },
      { allowHttp: this.options.allowHttp === true },
    );
    if (!verdict.ok) throw new TrudError("trud_response_invalid");
    this.described = verdict.release;
    return verdict.release;
  }

  async latest(): Promise<DmdReleaseFiles | null> {
    const release = await this.describe();
    await this.close();
    const root = await mkdtemp(join(this.options.workDir ?? tmpdir(), "harbour-dmd-"));
    this.directory = root;
    await chmod(root, 0o700);
    try {
      const archive = join(root, "archive.zip");
      await this.download(release, archive);
      const releaseDirectory = join(root, release.name);
      await mkdir(releaseDirectory, { mode: 0o700 });
      await unpack(archive, release.name, releaseDirectory, this.options.limits, 0);
      await rm(archive, { force: true });
      return await readDmdReleaseDirectory(releaseDirectory, "nhsbsa_trud", this.options.limits);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  /** Streams the archive to disk, checking its size and SHA-256 as it comes (rule 3). */
  private async download(release: TrudRelease, path: string): Promise<void> {
    const signal = AbortSignal.timeout(this.options.timeoutMs);
    const response = await this.get(release.archiveUrl, signal);
    if (!response.body) throw new TrudError("trud_response_invalid");
    const hash = createHash("sha256");
    let bytes = 0;
    const limit = release.bytes;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        if (bytes > limit) {
          done(new TrudError("download_too_large"));
          return;
        }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
        counter,
        createWriteStream(path, {
          flags: "wx",
          mode: 0o600,
        }),
      );
    } catch (error) {
      if (error instanceof TrudError) throw error;
      throw new TrudError("trud_unreachable");
    }
    if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) {
      throw new TrudError("checksum_mismatch");
    }
  }

  async close(): Promise<void> {
    const directory = this.directory;
    this.directory = null;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  async health(): Promise<HealthResult> {
    return {
      ok: true,
      detail: `TRUD adapter for item ${this.options.item}; reached only when the dm+d job runs.`,
    };
  }
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new TrudError("trud_response_invalid");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

interface Budget {
  files: number;
  bytes: number;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: true },
      (error, zip) => {
        if (error || !zip) reject(new TrudError("archive_unsafe"));
        else resolve(zip);
      },
    );
  });
}

/**
 * Unpacks a release archive (rule 4): plain XML file names only, at the top or in the release's
 * own folder, each written once; a zip nested one level deep is unpacked under the same rules.
 * Every byte inflated counts against the release's limit, so a small archive cannot fill the disk.
 */
async function unpack(
  archive: string,
  releaseName: string,
  into: string,
  limits: Pick<DmdLoadLimits, "maxFiles" | "maxBytes">,
  depth: number,
  budget: Budget = { files: 0, bytes: 0 },
): Promise<void> {
  const zip = await openZip(archive);
  const nested: { path: string; name: string }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) =>
        reject(error instanceof TrudError ? error : new TrudError("archive_unsafe"));
      zip.on("error", fail);
      zip.on("end", () => resolve());
      zip.on("entry", (entry: yauzl.Entry) => {
        const decided = dmdArchiveEntryName(entry.fileName, releaseName);
        if (decided.kind === "unsafe" || entry.isEncrypted()) {
          fail(new TrudError("archive_unsafe"));
          return;
        }
        if (decided.kind === "skip") {
          zip.readEntry();
          return;
        }
        if (decided.kind === "zip" && depth > 0) {
          fail(new TrudError("archive_unsafe"));
          return;
        }
        budget.files += 1;
        if (budget.files > limits.maxFiles) {
          fail(new TrudError("archive_too_large"));
          return;
        }
        if (budget.bytes + entry.uncompressedSize > limits.maxBytes) {
          fail(new TrudError("archive_too_large"));
          return;
        }
        const target =
          decided.kind === "zip"
            ? join(into, `.nested-${budget.files}.zip`)
            : join(into, decided.name);
        if (decided.kind === "zip") {
          nested.push({ path: target, name: decided.name.replace(/\.zip$/, "") });
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(new TrudError("archive_unsafe"));
            return;
          }
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              budget.bytes += chunk.length;
              if (budget.bytes > limits.maxBytes) done(new TrudError("archive_too_large"));
              else done(null, chunk);
            },
          });
          pipeline(
            stream,
            counter,
            // O_EXCL: a name already written (a duplicate entry) refuses the archive.
            createWriteStream(target, {
              flags: "wx",
              mode: 0o600,
            }),
          ).then(
            () => zip.readEntry(),
            (failure) => fail(failure),
          );
        });
      });
      zip.readEntry();
    });
  } finally {
    try {
      zip.close();
    } catch {
      // Already closed.
    }
  }
  for (const inner of nested) {
    await unpack(inner.path, inner.name, into, limits, depth + 1, budget);
    await rm(inner.path, { force: true });
  }
}

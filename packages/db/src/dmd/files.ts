import { constants, readdirSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DmdReleaseFileSource,
  type DmdReleaseFiles,
  type DmdReleaseSourceKind,
  dmdReleaseDateFromName,
} from "@harbour/domain";

/**
 * Release files on disk and in memory (integrations.md section 11 rule 1; ADR-0080). A release is
 * read in chunks, never whole, within limits set before anything is read: how many files, how many
 * bytes in all, and how long the load may take (the worker's `DMD_RELEASE_MAX_FILES`,
 * `DMD_RELEASE_MAX_BYTES` and `DMD_LOAD_TIMEOUT_MINUTES`). A symbolic link is refused, in the
 * directory and when a file is opened, so a release directory can never point the loader at
 * another file on the machine.
 */

export interface DmdLoadLimits {
  /** Files in one release directory (every regular file counts). */
  readonly maxFiles: number;
  /** Bytes in all the release's files. */
  readonly maxBytes: number;
  /** How long a load may take, reading and writing, in milliseconds. */
  readonly timeoutMs: number;
}

/** Technical bounds for a whole real release (slice 75 measures one, H-654); not statutory figures. */
export const DMD_LOAD_LIMITS: DmdLoadLimits = {
  maxFiles: 64,
  maxBytes: 2 * 1024 ** 3,
  timeoutMs: 60 * 60_000,
};

export class DmdReleaseFileError extends Error {}

const CHUNK_BYTES = 1024 * 1024;

/** A file on disk, opened without following a symbolic link and read in 1 MiB chunks. */
function fileSource(path: string, name: string, bytes: number): DmdReleaseFileSource {
  return {
    name,
    bytes,
    async *chunks() {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const buffer = Buffer.alloc(CHUNK_BYTES);
        let read = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          read += bytesRead;
          if (read > bytes) throw new DmdReleaseFileError(`${name} grew while it was read.`);
          yield decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
        }
        const tail = decoder.decode();
        if (tail) yield tail;
      } finally {
        await handle.close();
      }
    },
  };
}

/** A file held in memory (tests, and adapters that receive a file), yielded in chunks. */
export function dmdFileFromText(name: string, text: string): DmdReleaseFileSource {
  const characters = 64 * 1024;
  return {
    name,
    bytes: Buffer.byteLength(text, "utf8"),
    async *chunks() {
      for (let i = 0; i < text.length; i += characters) yield text.slice(i, i + characters);
    },
  };
}

/**
 * A release on disk: a directory named as the release (`nhsbsa_dmd_10.1.0_20261026000001`) holding
 * its XML files, as a TRUD download unzips (slice 75) or a person places them for a manual run.
 * Refuses a directory or file that is a symbolic link, anything but regular files, and more files
 * or bytes than the limits allow, before any file is read.
 */
export async function readDmdReleaseDirectory(
  directory: string,
  source: DmdReleaseSourceKind,
  limits: Pick<DmdLoadLimits, "maxFiles" | "maxBytes"> = DMD_LOAD_LIMITS,
): Promise<DmdReleaseFiles> {
  const name = basename(directory);
  const releasedOn = dmdReleaseDateFromName(name);
  if (releasedOn === null) {
    throw new DmdReleaseFileError(`The directory name ${name} does not carry a dm+d release date.`);
  }
  const self = await lstat(directory);
  if (!self.isDirectory() || self.isSymbolicLink()) {
    throw new DmdReleaseFileError(`${name} is not a directory (a symbolic link is refused).`);
  }
  const entries = (await readdir(directory)).sort();
  if (entries.length > limits.maxFiles) {
    throw new DmdReleaseFileError(`${name} holds more than ${limits.maxFiles} files.`);
  }
  const files: DmdReleaseFileSource[] = [];
  let total = 0;
  for (const entry of entries) {
    const path = join(directory, entry);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new DmdReleaseFileError(`${entry} is a symbolic link: refused.`);
    }
    if (!stat.isFile()) throw new DmdReleaseFileError(`${entry} is not a regular file.`);
    if (!entry.endsWith(".xml")) continue;
    total += stat.size;
    if (total > limits.maxBytes) {
      throw new DmdReleaseFileError(`${name} is larger than ${limits.maxBytes} bytes.`);
    }
    files.push(fileSource(path, entry, stat.size));
  }
  return { name, releasedOn, source, files };
}

/**
 * The invented fixture releases (ADR-0080: development and tests never use real dm+d files), oldest
 * first. Loaded only into a database marked for development or tests (`app.database_environment`).
 */
export function dmdFixtureReleaseDirectories(): string[] {
  const root = fileURLToPath(new URL("../../test/fixtures/dmd/", import.meta.url));
  return readdirSync(root)
    .filter((d) => dmdReleaseDateFromName(d) !== null)
    .sort((a, b) =>
      (dmdReleaseDateFromName(a) ?? "") < (dmdReleaseDateFromName(b) ?? "") ? -1 : 1,
    )
    .map((d) => join(root, d));
}

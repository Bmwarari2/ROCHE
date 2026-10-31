import { createHmac, timingSafeEqual } from "node:crypto";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw, inflateRawSync } from "node:zlib";
import {
  type ArchiveEntry,
  archiveProblem,
  type ElearningStandard,
  launchPathOf,
} from "@harbour/domain";
import { XMLParser } from "fast-xml-parser";

/**
 * E-learning packages (workforce.md section 14; ADR-0093). The archive is read from its central
 * directory and every entry is checked (`archiveProblem`) before anything is inflated; an entry
 * is inflated only up to the size it declares, and its CRC must match, so a lying header cannot
 * make a bomb. ZIP64, spanned and encrypted archives are refused: packages are at most 100 MB.
 * Nothing is ever written to disk from a package; files are read out of the stored archive when
 * the content origin asks for them.
 */

export interface ZipEntry extends ArchiveEntry {
  readonly crc: number;
  readonly localHeaderOffset: number;
  /** Where the entry's data starts, after its local header (checked against the central one). */
  readonly dataOffset: number;
}

/**
 * One file of a stored package as the course keeps it (`elearning_course.package_index`): the
 * path, where its data starts, its packed and unpacked sizes, CRC and method. Written once at
 * upload, after every entry was inflated and checked; files are then served by a ranged read of
 * just their bytes (review H2).
 */
export interface PackageIndexEntry {
  readonly p: string;
  readonly o: number;
  readonly c: number;
  readonly u: number;
  readonly k: number;
  readonly m: 0 | 8;
}

export class PackageProblem extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Bit 3: sizes and CRC follow the data in a descriptor (12 or 16 bytes). */
const DESCRIPTOR_FLAG = 0x0008;
const DESCRIPTOR_MAX = 16;

/**
 * The entries of an archive, from its central directory; refuses anything malformed or anything
 * two readers could see differently (review M3): the end record must be the last thing in the
 * file, with no ZIP64 locator; the central directory must end where the end record begins; each
 * local header must match its central entry (name, method, flags, and sizes and CRC unless they
 * follow in a descriptor); and the entries' data must tile the file from the first byte to the
 * central directory, with no overlap, no shared data and nothing hidden between them.
 */
export function readZipDirectory(bytes: Buffer): ZipEntry[] {
  if (bytes.length < 22) throw new PackageProblem("not_zip");
  // The end record is within the last 64 KB plus its own 22 bytes, and its comment ends the file.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (bytes.readUInt32LE(i) === EOCD && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new PackageProblem("not_zip");
  if (eocd >= 20 && bytes.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
    throw new PackageProblem("zip64");
  }
  const disk = bytes.readUInt16LE(eocd + 4);
  const cdDisk = bytes.readUInt16LE(eocd + 6);
  const onDisk = bytes.readUInt16LE(eocd + 8);
  const count = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new PackageProblem("spanned");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new PackageProblem("zip64");
  }
  if (onDisk !== count || cdOffset + cdSize !== eocd) throw new PackageProblem("malformed");
  const entries: ZipEntry[] = [];
  const flagsOf = new Map<ZipEntry, number>();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > eocd || bytes.readUInt32LE(p) !== CENTRAL) throw new PackageProblem("malformed");
    const madeBy = bytes.readUInt16LE(p + 4);
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const crc = bytes.readUInt32LE(p + 16);
    const compressedSize = bytes.readUInt32LE(p + 20);
    const uncompressedSize = bytes.readUInt32LE(p + 24);
    const nameLength = bytes.readUInt16LE(p + 28);
    const extraLength = bytes.readUInt16LE(p + 30);
    const commentLength = bytes.readUInt16LE(p + 32);
    const external = bytes.readUInt32LE(p + 38);
    const localHeaderOffset = bytes.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new PackageProblem("zip64");
    }
    if (p + 46 + nameLength + extraLength + commentLength > eocd) {
      throw new PackageProblem("malformed");
    }
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLength);
    // Names are UTF-8 when flag 11 says so; otherwise only plain ASCII is accepted.
    const utf8 = (flags & 0x0800) !== 0;
    if (!utf8 && nameBytes.some((b) => b > 0x7f)) throw new PackageProblem("entry_name");
    const name = nameBytes.toString("utf8");
    const unix = madeBy >> 8 === 3;
    const symlink = unix && ((external >>> 16) & 0o170000) === 0o120000;

    // The local header says the same as the central entry, or two readers could disagree.
    const at = localHeaderOffset;
    if (at + 30 > cdOffset || bytes.readUInt32LE(at) !== LOCAL) {
      throw new PackageProblem("malformed");
    }
    const localNameLength = bytes.readUInt16LE(at + 26);
    const localExtraLength = bytes.readUInt16LE(at + 28);
    const dataOffset = at + 30 + localNameLength + localExtraLength;
    if (
      bytes.readUInt16LE(at + 6) !== flags ||
      bytes.readUInt16LE(at + 8) !== method ||
      dataOffset > cdOffset ||
      !bytes.subarray(at + 30, at + 30 + localNameLength).equals(nameBytes)
    ) {
      throw new PackageProblem("malformed");
    }
    if (
      (flags & DESCRIPTOR_FLAG) === 0 &&
      (bytes.readUInt32LE(at + 14) !== crc ||
        bytes.readUInt32LE(at + 18) !== compressedSize ||
        bytes.readUInt32LE(at + 22) !== uncompressedSize)
    ) {
      throw new PackageProblem("malformed");
    }
    const entry: ZipEntry = {
      name,
      compressedSize,
      uncompressedSize,
      method,
      encrypted: (flags & 0x0001) !== 0,
      symlink,
      crc,
      localHeaderOffset,
      dataOffset,
    };
    entries.push(entry);
    flagsOf.set(entry, flags);
    p += 46 + nameLength + extraLength + commentLength;
  }
  if (p !== cdOffset + cdSize) throw new PackageProblem("malformed");

  // The entries tile the file: the first at byte 0, each starting where the last one's data (and
  // descriptor) ends, the last ending at the central directory. No overlap, no shared data.
  const ordered = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  let next = 0;
  let slack = 0;
  for (const entry of ordered) {
    if (entry.localHeaderOffset < next || entry.localHeaderOffset > next + slack) {
      throw new PackageProblem("malformed");
    }
    next = entry.dataOffset + entry.compressedSize;
    slack = ((flagsOf.get(entry) ?? 0) & DESCRIPTOR_FLAG) !== 0 ? DESCRIPTOR_MAX : 0;
  }
  if (cdOffset < next || cdOffset > next + slack) throw new PackageProblem("malformed");
  return entries;
}

/** One file out of the archive, checked against its declared size and CRC. */
export function extractEntry(bytes: Buffer, entry: ZipEntry): Buffer {
  const start = entry.dataOffset;
  const end = start + entry.compressedSize;
  if (end > bytes.length) throw new PackageProblem("malformed");
  const data = bytes.subarray(start, end);
  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    try {
      // Never more than the declared size: a header that lies about it fails here.
      out = inflateRawSync(data, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
    } catch {
      throw new PackageProblem("malformed");
    }
  } else {
    throw new PackageProblem("method");
  }
  if (out.length !== entry.uncompressedSize || crc32(out) >>> 0 !== entry.crc >>> 0) {
    throw new PackageProblem("malformed");
  }
  return out;
}

/**
 * A file's bytes as a stream, from a stream of its packed bytes: inflated (method 8) or passed
 * through (method 0), never beyond its declared size, and failing at the end unless the length
 * and CRC match. Memory stays at a few chunks whatever the file's size (review H2).
 */
export function entryStream(packed: AsyncIterable<Uint8Array>, entry: PackageIndexEntry): Readable {
  let length = 0;
  let crc = 0;
  const check = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      length += chunk.length;
      if (length > entry.u) {
        done(new PackageProblem("malformed"));
        return;
      }
      crc = crc32(chunk, crc);
      done(null, chunk);
    },
    flush(done) {
      done(
        length === entry.u && crc >>> 0 === entry.k >>> 0 ? null : new PackageProblem("malformed"),
      );
    },
  });
  const source = Readable.from(packed);
  const out = new PassThrough();
  const done = (error: unknown) => out.destroy(error as Error);
  if (entry.m === 8) {
    pipeline(source, createInflateRaw({ maxOutputLength: Math.max(entry.u, 1) }), check, out).catch(
      done,
    );
  } else {
    pipeline(source, check, out).catch(done);
  }
  return out;
}

/** Inflates and checks every file of a package, as a stream each (review H2, M3). */
export async function verifyEntries(bytes: Buffer, index: readonly PackageIndexEntry[]) {
  for (const entry of index) {
    const slice = bytes.subarray(entry.o, entry.o + entry.c);
    const packed = (async function* () {
      yield slice;
    })();
    try {
      for await (const _ of entryStream(packed, entry)) {
        // Read to the end: the check fails the stream on a wrong size or CRC.
      }
    } catch {
      throw new PackageProblem("malformed");
    }
  }
}

/** The index a course keeps: its files (not folders), with where each one's data is. */
export function packageIndex(entries: readonly ZipEntry[]): PackageIndexEntry[] {
  return entries
    .filter((e) => !e.name.endsWith("/"))
    .map((e) => ({
      p: e.name,
      o: e.dataOffset,
      c: e.compressedSize,
      u: e.uncompressedSize,
      k: e.crc >>> 0,
      m: e.method === 8 ? 8 : 0,
    }));
}

/** Longest manifest read (a manifest is a few kilobytes; anything larger is refused). */
const MANIFEST_MAX_BYTES = 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  // No entities are expanded at all (no XXE, no billion laughs); manifests need none.
  processEntities: false,
  parseTagValue: false,
  // A manifest nests a few levels; a deeply nested one is refused, not recursed into (review L3).
  maxNestedTags: 64,
  isArray: (name) => ["organization", "item", "resource", "activity", "file"].includes(name),
});

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node => (v && typeof v === "object" ? (v as Node) : {});
const asList = (v: unknown): Node[] => (Array.isArray(v) ? v.map(asNode) : v ? [asNode(v)] : []);
const text = (v: unknown): string =>
  typeof v === "string"
    ? v
    : typeof asNode(v)["#text"] === "string"
      ? String(asNode(v)["#text"])
      : "";

export interface PackageSummary {
  readonly standard: ElearningStandard;
  readonly launchPath: string;
  readonly launchQuery: string;
  readonly identifier: string | null;
  readonly fileCount: number;
  readonly unpackedBytes: number;
  readonly index: readonly PackageIndexEntry[];
}

/** Deepest nesting of manifest items followed (review L3). */
const MANIFEST_MAX_DEPTH = 32;

/**
 * Checks a package and finds how it launches: SCORM from `imsmanifest.xml` (the default
 * organisation's first item with a resource, the resource's `xml:base` honoured), xAPI from
 * `tincan.xml` (the first activity's launch). Throws `PackageProblem` with a code.
 */
export function analysePackage(bytes: Buffer): PackageSummary {
  try {
    return analyse(bytes);
  } catch (error) {
    // Anything unexpected is a refusal, never a 500 (review L3).
    if (error instanceof PackageProblem) throw error;
    throw new PackageProblem("malformed");
  }
}

function analyse(bytes: Buffer): PackageSummary {
  const entries = readZipDirectory(bytes);
  const problem = archiveProblem(entries);
  if (problem) throw new PackageProblem(`archive_${problem.problem}`);
  const files = entries.filter((e) => !e.name.endsWith("/"));
  const byName = new Map(files.map((e) => [e.name, e]));
  const names = new Set(byName.keys());
  const unpackedBytes = files.reduce((n, e) => n + e.uncompressedSize, 0);
  const index = packageIndex(entries);
  const read = (name: string) => {
    const entry = byName.get(name);
    if (!entry) return null;
    if (entry.uncompressedSize > MANIFEST_MAX_BYTES) throw new PackageProblem("manifest_too_large");
    return extractEntry(bytes, entry).toString("utf8");
  };
  const scorm = read("imsmanifest.xml");
  if (scorm !== null) {
    const doc = asNode(parseXml(scorm).manifest);
    const schemaVersion = text(asNode(doc.metadata).schemaversion).trim();
    const standard: ElearningStandard =
      schemaVersion === "1.2"
        ? "scorm_1_2"
        : /2004|CAM 1\.3/i.test(schemaVersion)
          ? "scorm_2004"
          : "scorm_1_2";
    const orgs = asNode(doc.organizations);
    const all = asList(orgs.organization);
    const chosen = all.find((o) => o["@identifier"] === orgs["@default"]) ?? all[0];
    const resources = asNode(doc.resources);
    const resourceBase = typeof resources["@base"] === "string" ? resources["@base"] : "";
    const list = asList(resources.resource);
    const firstItemRef = (items: Node[], depth: number): string | null => {
      if (depth > MANIFEST_MAX_DEPTH) throw new PackageProblem("manifest_unreadable");
      for (const item of items) {
        if (typeof item["@identifierref"] === "string") return item["@identifierref"];
        const nested = firstItemRef(asList(item.item), depth + 1);
        if (nested) return nested;
      }
      return null;
    };
    const ref = chosen ? firstItemRef(asList(chosen.item), 0) : null;
    const resource =
      list.find((r) => r["@identifier"] === ref) ??
      list.find((r) => String(r["@scormtype"] ?? r["@scormType"] ?? "").toLowerCase() === "sco");
    const href = typeof resource?.["@href"] === "string" ? resource["@href"] : null;
    if (!resource || !href) throw new PackageProblem("no_launch");
    const base = `${resourceBase}${typeof resource["@base"] === "string" ? resource["@base"] : ""}`;
    const launch = launchPathOf(href, base, names);
    if (!launch) throw new PackageProblem("bad_launch");
    return {
      standard,
      launchPath: launch.path,
      launchQuery: launch.query,
      identifier: typeof doc["@identifier"] === "string" ? doc["@identifier"].slice(0, 200) : null,
      fileCount: files.length,
      unpackedBytes,
      index,
    };
  }
  const tincan = read("tincan.xml");
  if (tincan !== null) {
    const activities = asList(asNode(asNode(parseXml(tincan).tincan).activities).activity);
    const activity = activities.find((a) => text(a.launch).trim() !== "");
    if (!activity) throw new PackageProblem("no_launch");
    const launch = launchPathOf(text(activity.launch), "", names);
    if (!launch) throw new PackageProblem("bad_launch");
    return {
      standard: "xapi",
      launchPath: launch.path,
      launchQuery: launch.query,
      identifier: typeof activity["@id"] === "string" ? activity["@id"].slice(0, 200) : null,
      fileCount: files.length,
      unpackedBytes,
      index,
    };
  }
  throw new PackageProblem("no_manifest");
}

function parseXml(xml: string): Node {
  // A DOCTYPE could declare entities; manifests have no need of one.
  if (/<!DOCTYPE/i.test(xml)) throw new PackageProblem("manifest_doctype");
  try {
    return asNode(parser.parse(xml));
  } catch {
    throw new PackageProblem("manifest_unreadable");
  }
}

/** Words for a package refusal (no internals, no file names from the package). */
export function packageProblemMessage(code: string): string {
  if (
    code === "archive_ratio" ||
    code === "archive_too_large" ||
    code === "archive_too_many_entries"
  ) {
    return "The package is too large when unpacked. Packages may hold at most 5,000 files and 500 MB.";
  }
  if (code === "archive_file_type") {
    return "The package holds a kind of file that is not allowed (only web pages, scripts, styles, images, audio, video, fonts and PDFs).";
  }
  if (code.startsWith("archive_entry_name") || code === "entry_name") {
    return "The package holds a file whose name points outside the package. It cannot be used.";
  }
  if (code === "no_manifest") {
    return "The package has no imsmanifest.xml (SCORM) or tincan.xml (xAPI) at its top level.";
  }
  if (code === "no_launch" || code === "bad_launch") {
    return "The package's manifest does not name a launch page inside the package.";
  }
  return "The file is not a package Harbour can use. Export it again as a SCORM 1.2, SCORM 2004 or xAPI zip file.";
}

/** The index entry for a path, or null when the package holds no such file. */
export function indexEntry(
  index: readonly PackageIndexEntry[],
  path: string,
): PackageIndexEntry | null {
  return index.find((e) => e.p === path) ?? null;
}

// ------------------------------------------------------------------------------------------------
// Launch tokens: what the content origin presents for one attempt (ADR-0093)
// ------------------------------------------------------------------------------------------------

export interface LaunchClaims {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly workerId: string;
  readonly courseId: string;
  /** The attempt's launch nonce when the token was made; a later launch replaces it (review M6). */
  readonly nonce: string;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** `payload.signature`, both base64url: safe in a URL path segment. */
export function signLaunchToken(claims: LaunchClaims, secret: string): string {
  const payload = b64(
    JSON.stringify([
      claims.attemptId,
      claims.tenantId,
      claims.workerId,
      claims.courseId,
      claims.nonce,
      claims.expiresAt,
    ]),
  );
  const sig = createHmac("sha256", secret)
    .update(`elearning-launch.${payload}`)
    .digest("base64url");
  return `${payload}.${sig}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The claims of a valid, unexpired token, or null. */
export function verifyLaunchToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): LaunchClaims | null {
  if (token.length > 512) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(`elearning-launch.${payload}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const [attemptId, tenantId, workerId, courseId, nonce, expiresAt] = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as [string, string, string, string, string, number];
    if (
      ![attemptId, tenantId, workerId, courseId, nonce].every(
        (v) => typeof v === "string" && UUID.test(v),
      )
    )
      return null;
    if (typeof expiresAt !== "number" || expiresAt * 1000 <= now.getTime()) return null;
    return { attemptId, tenantId, workerId, courseId, nonce, expiresAt };
  } catch {
    return null;
  }
}

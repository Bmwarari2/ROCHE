/**
 * The e-learning runtime's rules (workforce.md section 14; slice 43; WORK-006; ADR-0093). A
 * package is untrusted: its archive is checked entry by entry before anything is kept (no path
 * leaving the package, no links, no bombs, only allowlisted file types), and what the content
 * reports through the SCORM data model is read only through an allowlist with bounded lengths.
 * Limits are Harbour's product settings, not statutory figures.
 */

export const ELEARNING_STANDARDS = ["scorm_1_2", "scorm_2004", "xapi"] as const;
export type ElearningStandard = (typeof ELEARNING_STANDARDS)[number];

/** What a package's archive may hold (ADR-0093). */
export const ARCHIVE_LIMITS = {
  /** Entries in the archive, folders included. */
  maxEntries: 5000,
  /** Every file unpacked, together. */
  maxTotalBytes: 500 * 1024 * 1024,
  /** One file unpacked. */
  maxEntryBytes: 200 * 1024 * 1024,
  /** Unpacked size over packed size, for one file and for the archive (zip bombs). */
  maxRatio: 100,
  /** Characters in an entry's path. */
  maxPathLength: 240,
} as const;

export type EntryNameProblem =
  | "empty"
  | "too_long"
  | "absolute"
  | "traversal"
  | "backslash"
  | "control"
  | "drive"
  | "reserved";

/**
 * Whether an archive entry's name is a safe relative path inside the package: forward slashes
 * only, no leading slash or drive, no `.` or `..` segment, no control characters, no empty
 * segment, not longer than the limit. Folders end with one slash.
 */
export function entryNameProblem(name: string): EntryNameProblem | null {
  if (name.length === 0) return "empty";
  if (name.length > ARCHIVE_LIMITS.maxPathLength) return "too_long";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    // C0 and C1 controls, line and paragraph separators, and bidirectional overrides and isolates,
    // which can make a name display as something else (review L6).
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return "control";
    }
  }
  // One spelling only: a name that is not in Unicode normal form C could alias another.
  if (name.normalize("NFC") !== name) return "control";
  if (name.includes("\\")) return "backslash";
  if (name.startsWith("/")) return "absolute";
  if (/^[a-zA-Z]:/.test(name)) return "drive";
  const segments = (name.endsWith("/") ? name.slice(0, -1) : name).split("/");
  for (const segment of segments) {
    if (segment === "") return "traversal";
    if (segment === "." || segment === "..") return "traversal";
    if (segment.endsWith(" ") || segment.endsWith(".")) return "reserved";
  }
  return null;
}

export interface ArchiveEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** 0 stored, 8 deflate; anything else is refused. */
  readonly method: number;
  readonly encrypted: boolean;
  /** A Unix symbolic link (external attributes), refused. */
  readonly symlink: boolean;
}

export type ArchiveProblem =
  | { readonly problem: "empty" }
  | { readonly problem: "too_many_entries" }
  | { readonly problem: "too_large" }
  | { readonly problem: "ratio"; readonly name?: string }
  | { readonly problem: "entry_name"; readonly name: string; readonly reason: EntryNameProblem }
  | { readonly problem: "duplicate"; readonly name: string }
  | { readonly problem: "method"; readonly name: string }
  | { readonly problem: "encrypted"; readonly name: string }
  | { readonly problem: "symlink"; readonly name: string }
  | { readonly problem: "file_type"; readonly name: string };

const isFolder = (name: string) => name.endsWith("/");

/** Checks a package's central directory before any entry is unpacked. */
export function archiveProblem(entries: readonly ArchiveEntry[]): ArchiveProblem | null {
  if (entries.length === 0) return { problem: "empty" };
  if (entries.length > ARCHIVE_LIMITS.maxEntries) return { problem: "too_many_entries" };
  const seen = new Set<string>();
  let total = 0;
  let packed = 0;
  for (const e of entries) {
    const reason = entryNameProblem(e.name);
    if (reason) return { problem: "entry_name", name: e.name, reason };
    // Case-insensitive file systems would let one entry overwrite another.
    const key = e.name.normalize("NFC").toLowerCase();
    if (seen.has(key)) return { problem: "duplicate", name: e.name };
    seen.add(key);
    if (e.symlink) return { problem: "symlink", name: e.name };
    if (e.encrypted) return { problem: "encrypted", name: e.name };
    if (e.method !== 0 && e.method !== 8) return { problem: "method", name: e.name };
    if (isFolder(e.name)) continue;
    if (contentTypeOf(e.name) === null) return { problem: "file_type", name: e.name };
    if (e.uncompressedSize > ARCHIVE_LIMITS.maxEntryBytes) return { problem: "too_large" };
    if (e.uncompressedSize > Math.max(e.compressedSize, 1) * ARCHIVE_LIMITS.maxRatio) {
      return { problem: "ratio", name: e.name };
    }
    total += e.uncompressedSize;
    packed += e.compressedSize;
    if (total > ARCHIVE_LIMITS.maxTotalBytes) return { problem: "too_large" };
  }
  if (total > Math.max(packed, 1) * ARCHIVE_LIMITS.maxRatio) return { problem: "ratio" };
  return null;
}

/**
 * The file types a package may hold, and the type each is served with. No server-side code, no
 * executables, no archives inside archives; HTML and script run only on the content origin.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  xml: "application/xml",
  xsd: "application/xml",
  dtd: "application/xml-dtd",
  txt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
};

/** The type a package file is served with, or null when its type is not allowed. */
export function contentTypeOf(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(CONTENT_TYPES, ext) ? (CONTENT_TYPES[ext] ?? null) : null;
}

/**
 * A manifest's launch reference as a path inside the package and its query: the path must be a
 * safe entry name of an HTML file the package holds; the query (SCORM parameters) is kept apart.
 */
export function launchPathOf(
  href: string,
  base: string,
  files: ReadonlySet<string>,
): { readonly path: string; readonly query: string } | null {
  const [rawPath = "", query = ""] = href.trim().split("?", 2);
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith("//")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  const path = `${base}${decoded}`;
  if (entryNameProblem(path) || path.endsWith("/")) return null;
  if (!contentTypeOf(path)?.startsWith("text/html")) return null;
  if (!files.has(path)) return null;
  return { path, query: query.slice(0, 500) };
}

// ------------------------------------------------------------------------------------------------
// The SCORM data model, as the runtime reports it
// ------------------------------------------------------------------------------------------------

/** The data model elements kept, per standard, with their longest value. */
export const CMI_ELEMENTS: Readonly<
  Record<"scorm_1_2" | "scorm_2004", Readonly<Record<string, number>>>
> = {
  scorm_1_2: {
    "cmi.core.lesson_status": 20,
    "cmi.core.lesson_location": 255,
    "cmi.core.score.raw": 20,
    "cmi.core.score.min": 20,
    "cmi.core.score.max": 20,
    "cmi.core.session_time": 20,
    "cmi.core.exit": 20,
    "cmi.suspend_data": 64000,
  },
  scorm_2004: {
    "cmi.completion_status": 20,
    "cmi.success_status": 20,
    "cmi.location": 1000,
    "cmi.score.scaled": 20,
    "cmi.score.raw": 20,
    "cmi.score.min": 20,
    "cmi.score.max": 20,
    "cmi.progress_measure": 20,
    "cmi.session_time": 40,
    "cmi.exit": 20,
    "cmi.suspend_data": 64000,
  },
};

const LESSON_STATUS = ["passed", "completed", "failed", "incomplete", "browsed", "not attempted"];
const COMPLETION_STATUS = ["completed", "incomplete", "not attempted", "unknown"];
const SUCCESS_STATUS = ["passed", "failed", "unknown"];
const DECIMAL = /^-?\d{1,10}(\.\d{1,7})?$/;

export type CmiProblem =
  | { readonly problem: "unknown_element"; readonly element: string }
  | { readonly problem: "too_long"; readonly element: string }
  | { readonly problem: "bad_value"; readonly element: string };

/** Checks the data model values a runtime sends: known elements, bounded, well formed. */
export function cmiProblem(
  standard: "scorm_1_2" | "scorm_2004",
  values: Readonly<Record<string, string>>,
): CmiProblem | null {
  const allowed = CMI_ELEMENTS[standard];
  for (const [element, value] of Object.entries(values)) {
    const max = allowed[element];
    if (max === undefined) return { problem: "unknown_element", element };
    if (typeof value !== "string") return { problem: "bad_value", element };
    if (value.length > max) return { problem: "too_long", element };
    const bad =
      (element === "cmi.core.lesson_status" && !LESSON_STATUS.includes(value)) ||
      (element === "cmi.completion_status" && !COMPLETION_STATUS.includes(value)) ||
      (element === "cmi.success_status" && !SUCCESS_STATUS.includes(value)) ||
      (element.includes(".score.") && value !== "" && !DECIMAL.test(value)) ||
      (element === "cmi.progress_measure" && value !== "" && !DECIMAL.test(value));
    if (bad) return { problem: "bad_value", element };
  }
  return null;
}

export const ATTEMPT_STATUSES = ["in_progress", "completed", "passed", "failed"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

const num = (v: string | undefined) =>
  v !== undefined && v !== "" && DECIMAL.test(v) ? Number(v) : null;

/**
 * Where an attempt stands from what the content reported, and its score scaled 0 to 1 (or null).
 * SCORM 1.2: `lesson_status` (passed and failed decide; completed completes; the rest are in
 * progress). SCORM 2004: `success_status` decides pass or fail when known, else
 * `completion_status` completes. A 1.2 score is raw over min and max (0 to 100 when not given).
 */
export function attemptOutcome(
  standard: "scorm_1_2" | "scorm_2004",
  cmi: Readonly<Record<string, string>>,
): { readonly status: AttemptStatus; readonly score: number | null } {
  if (standard === "scorm_1_2") {
    const s = cmi["cmi.core.lesson_status"];
    const status: AttemptStatus =
      s === "passed"
        ? "passed"
        : s === "failed"
          ? "failed"
          : s === "completed"
            ? "completed"
            : "in_progress";
    const raw = num(cmi["cmi.core.score.raw"]);
    const min = num(cmi["cmi.core.score.min"]) ?? 0;
    const max = num(cmi["cmi.core.score.max"]) ?? 100;
    const score = raw === null || max <= min ? null : clamp01((raw - min) / (max - min));
    return { status, score };
  }
  const success = cmi["cmi.success_status"];
  const completion = cmi["cmi.completion_status"];
  const status: AttemptStatus =
    success === "passed"
      ? "passed"
      : success === "failed"
        ? "failed"
        : completion === "completed"
          ? "completed"
          : "in_progress";
  const scaled = num(cmi["cmi.score.scaled"]);
  let score: number | null = scaled === null ? null : clamp01(scaled);
  if (score === null) {
    const raw = num(cmi["cmi.score.raw"]);
    const min = num(cmi["cmi.score.min"]);
    const max = num(cmi["cmi.score.max"]);
    if (raw !== null && min !== null && max !== null && max > min) {
      score = clamp01((raw - min) / (max - min));
    }
  }
  return { status, score };
}

function clamp01(n: number): number {
  return Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
}

/** Whether an outcome completes the course for the training record (a fail never does). */
export function completesTraining(status: AttemptStatus): boolean {
  return status === "completed" || status === "passed";
}

/** Seconds in a session time: SCORM 1.2 `HHHH:MM:SS.SS`, SCORM 2004 an ISO 8601 duration. */
export function sessionSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const old = /^(\d{2,4}):([0-5]\d):([0-5]\d)(\.\d{1,2})?$/.exec(value);
  if (old) return Number(old[1]) * 3600 + Number(old[2]) * 60 + Number(old[3]);
  const iso = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!iso || value === "P" || value.endsWith("T")) return null;
  const [, d, h, m, s] = iso;
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(m ?? 0) * 60 +
    Math.floor(Number(s ?? 0))
  );
}

// ------------------------------------------------------------------------------------------------
// xAPI statements kept in Harbour (no external learning record store)
// ------------------------------------------------------------------------------------------------

/** Verbs that complete a course from xAPI content (ADL verbs). */
export const XAPI_COMPLETING_VERBS = new Set([
  "http://adlnet.gov/expapi/verbs/completed",
  "http://adlnet.gov/expapi/verbs/passed",
]);
export const XAPI_FAILED_VERB = "http://adlnet.gov/expapi/verbs/failed";

/** Longest statement kept, as JSON. */
export const XAPI_STATEMENT_MAX_BYTES = 16 * 1024;

/** The outcome an xAPI statement reports, if it is one that settles the attempt. */
export function xapiOutcome(
  verb: string,
  scaled: number | null | undefined,
): { readonly status: AttemptStatus; readonly score: number | null } | null {
  const score = typeof scaled === "number" && Number.isFinite(scaled) ? clamp01(scaled) : null;
  if (verb === "http://adlnet.gov/expapi/verbs/passed") return { status: "passed", score };
  if (verb === "http://adlnet.gov/expapi/verbs/completed") return { status: "completed", score };
  if (verb === XAPI_FAILED_VERB) return { status: "failed", score };
  return null;
}

/**
 * An attempt's status only moves forward: a settled pass or completion is never undone, and a
 * fail is final for that attempt, so a later commit or statement cannot turn it into a pass (a
 * retake is a new attempt; review M1).
 */
export function nextAttemptStatus(current: AttemptStatus, reported: AttemptStatus): AttemptStatus {
  if (current === "passed" || current === "completed" || current === "failed") return current;
  return reported;
}

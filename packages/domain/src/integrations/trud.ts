/**
 * The TRUD dm+d download's rules (integrations.md section 11, "Release download"; slice 75;
 * ADR-0080; HZ-113). Pure: what TRUD's answer must say before anything is downloaded, which
 * addresses the download may reach, and which names inside the archive are unpacked. The adapter
 * (`apps/api/src/integrations/trud.ts`) applies them; nothing here touches the network.
 */

import { dmdReleaseDateFromName } from "../medicines/dmd-release";

/** TRUD's own host (NHS England's Technology Reference data Update Distribution). */
export const TRUD_DEFAULT_HOSTS: readonly string[] = ["isd.digital.nhs.uk"];

/** The TRUD item for the NHSBSA dm+d release (item 24). */
export const TRUD_DMD_ITEM = 24;

export type TrudProblemCode =
  | "trud_unreachable"
  | "trud_refused"
  | "trud_response_invalid"
  | "checksum_mismatch"
  | "download_too_large"
  | "archive_unsafe"
  | "archive_too_large";

export interface TrudRelease {
  /** The release's own name: the archive's file name without `.zip`. */
  readonly name: string;
  /** YYYY-MM-DD, from the name. */
  readonly releasedOn: string;
  readonly archiveUrl: string;
  /** The archive's size as TRUD declares it. */
  readonly bytes: number;
  /** The archive's SHA-256 as TRUD declares it, lower case. */
  readonly sha256: string;
}

export type TrudReleaseVerdict =
  | { readonly ok: true; readonly release: TrudRelease }
  | { readonly ok: false; readonly code: "trud_response_invalid"; readonly reason: string };

const ARCHIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;

function invalid(reason: string): TrudReleaseVerdict {
  return { ok: false, code: "trud_response_invalid", reason };
}

/**
 * Checks TRUD's answer to `releases?latest` (rule 1). The reason names the field, never a value:
 * the answer's addresses carry the API key.
 */
export function checkTrudRelease(
  body: unknown,
  limits: { readonly maxArchiveBytes: number; readonly allowedHosts: readonly string[] },
  options: { readonly allowHttp?: boolean } = {},
): TrudReleaseVerdict {
  const releases = (body as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases)) return invalid("no releases list");
  if (releases.length !== 1) return invalid(`expected one release, got ${releases.length}`);
  const r = releases[0] as Record<string, unknown> | null;
  if (r === null || typeof r !== "object") return invalid("the release is not an object");
  const file = r.archiveFileName;
  if (typeof file !== "string" || !ARCHIVE_NAME.test(file)) return invalid("archiveFileName");
  const name = file.slice(0, -".zip".length);
  const releasedOn = dmdReleaseDateFromName(name);
  if (releasedOn === null) return invalid("archiveFileName carries no release date");
  const url = r.archiveFileUrl;
  if (typeof url !== "string" || !trudUrlAllowed(url, limits.allowedHosts, options)) {
    return invalid("archiveFileUrl");
  }
  const bytes = r.archiveFileSizeBytes;
  if (
    typeof bytes !== "number" ||
    !Number.isInteger(bytes) ||
    bytes <= 0 ||
    bytes > limits.maxArchiveBytes
  ) {
    return invalid("archiveFileSizeBytes");
  }
  const sha = typeof r.archiveFileSha256 === "string" ? r.archiveFileSha256.toLowerCase() : "";
  if (!SHA256.test(sha)) return invalid("archiveFileSha256");
  return { ok: true, release: { name, releasedOn, archiveUrl: url, bytes, sha256: sha } };
}

/**
 * Whether the download may reach an address (rule 3): HTTPS (plain HTTP only when a test asks),
 * on an allowed host exactly (with its port, if any, named too), with no user name or password.
 */
export function trudUrlAllowed(
  url: string,
  allowedHosts: readonly string[],
  options: { readonly allowHttp?: boolean } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const schemeOk =
    parsed.protocol === "https:" || (options.allowHttp === true && parsed.protocol === "http:");
  if (!schemeOk || parsed.username !== "" || parsed.password !== "") return false;
  return allowedHosts.map((h) => h.toLowerCase()).includes(parsed.host.toLowerCase());
}

export type DmdArchiveEntry =
  | { readonly kind: "xml" | "zip"; readonly name: string }
  | { readonly kind: "skip" }
  | { readonly kind: "unsafe" };

const ENTRY_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * What to do with one name inside the archive (rule 4): a plain file name, at the top or inside
 * the release's own folder, kept when it is XML or a nested zip; anything else that could reach
 * outside the release's directory is unsafe and refuses the whole archive.
 */
export function dmdArchiveEntryName(entry: string, releaseName: string): DmdArchiveEntry {
  if (entry === "" || entry.includes("\\") || entry.startsWith("/")) return { kind: "unsafe" };
  const parts = entry.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return { kind: "unsafe" };
  let file: string;
  if (parts.length === 1) file = parts[0] ?? "";
  else if (parts.length === 2 && parts[0] === releaseName) {
    file = parts[1] ?? "";
    if (file === "") return { kind: "skip" };
  } else return { kind: "unsafe" };
  if (!ENTRY_FILE.test(file)) return { kind: "unsafe" };
  if (file.endsWith(".xml")) return { kind: "xml", name: file };
  if (file.endsWith(".zip")) return { kind: "zip", name: file };
  return { kind: "skip" };
}

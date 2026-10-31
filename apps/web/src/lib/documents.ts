import type { DocumentItem } from "@harbour/contracts";
import { DEFAULT_SIGNATURE_STATEMENT, DOCUMENT_CATEGORIES } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { SafetyChip } from "./incidents";
import type { FormLike } from "./uk-time";

/**
 * The organisation's document library (PLAT-009; platform.md, document store): what a document's
 * status is called (an icon and a word), its size in words, and reading the upload and signing
 * forms with the API's own limits. Pure and unit tested; the API checks everything again.
 */

export const DOCUMENTS_PAGE = "/documents";
export const DOCUMENT_MANAGE = "platform.document.manage";
export const ORGANISATION_LIMIT = DOCUMENT_CATEGORIES.organisation_document;
/** The organisation document limit in megabytes as the domain counts them (1,048,576 bytes). */
export const ORGANISATION_LIMIT_MB = ORGANISATION_LIMIT.maxBytes / 1_048_576;
export const TITLE_MIN = 2;
export const TITLE_MAX = 160;
export const SIGNER_NAME_MIN = 2;
export const SIGNER_NAME_MAX = 120;
export { DEFAULT_SIGNATURE_STATEMENT };

export function documentPage(id: string): string {
  return `${DOCUMENTS_PAGE}/${id}/details`;
}

/** Where the file is fetched (audited by the API, never cached). */
export function documentDownload(id: string): string {
  return `${DOCUMENTS_PAGE}/${id}`;
}

const CHIPS: Record<DocumentItem["status"], Omit<SafetyChip, "label">> = {
  available: { status: "done", icon: "circle-check" },
  quarantined: { status: "overdue", icon: "triangle-alert" },
  destroyed: { status: "notApplicable", icon: "circle-minus" },
};

/** A document's status as an icon and a word; one the web does not know warns. */
export function documentChip(status: string, t: Translator): SafetyChip {
  const known = CHIPS[status as DocumentItem["status"]];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("documents.status", { status: known ? status : "unknown" }),
  };
}

/** "240 KB" or "3.2 MB". */
export function fileSize(bytes: number, t: Translator): string {
  if (bytes < 1_000_000)
    return t("documents.size.kb", { kb: Math.max(1, Math.round(bytes / 1000)) });
  return t("documents.size.mb", { mb: (bytes / 1_000_000).toFixed(1) });
}

/** A file from a form, as the browser gives it (a File in the page and in a server action). */
export interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

function isFile(value: unknown): value is FileLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "size" in value &&
    "name" in value &&
    typeof (value as FileLike).size === "number"
  );
}

const text = (form: FormLike, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
};

export type FileCheck =
  | { readonly ok: true; readonly file: FileLike }
  | { readonly ok: false; readonly error: string };

/** A PDF of at most the organisation document limit (25 MB); said in words at the field. */
export function checkFile(value: unknown, t: Translator): FileCheck {
  if (!isFile(value) || value.size === 0)
    return { ok: false, error: t("documents.upload.fileRequired") };
  if (value.type !== "application/pdf" && !value.name.toLowerCase().endsWith(".pdf")) {
    return { ok: false, error: t("documents.upload.pdfOnly") };
  }
  if (value.size > ORGANISATION_LIMIT.maxBytes) {
    return {
      ok: false,
      error: t("documents.upload.tooLarge", { mb: ORGANISATION_LIMIT_MB }),
    };
  }
  return { ok: true, file: value };
}

export type UploadRead =
  | { readonly ok: true; readonly title: string; readonly file: FileLike }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** The upload form: a title of 2 to 160 characters and a PDF. */
export function readUpload(
  form: FormLike,
  t: Translator,
  options: { readonly needsTitle: boolean },
): UploadRead {
  const errors: Record<string, string> = {};
  const title = text(form, "title");
  if (options.needsTitle && (title.length < TITLE_MIN || title.length > TITLE_MAX)) {
    errors.title = t("documents.upload.titleError", { min: TITLE_MIN, max: TITLE_MAX });
  }
  const file = checkFile(form.get("file"), t);
  if (!file.ok) errors.file = file.error;
  if (Object.keys(errors).length > 0 || !file.ok) return { ok: false, errors };
  return { ok: true, title, file: file.file };
}

/** A file name safe to send in the query string: its last part, at most 255 characters. */
export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? "";
  return last.slice(-255);
}

export type SignatureRead =
  | { readonly ok: true; readonly typedName: string }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/** The signing form: the signer's full name (2 to 120 characters) and that they have read it. */
export function readSignature(form: FormLike, t: Translator): SignatureRead {
  const errors: Record<string, string> = {};
  const typedName = text(form, "typedName");
  if (typedName.length < SIGNER_NAME_MIN || typedName.length > SIGNER_NAME_MAX) {
    errors.typedName = t("documents.sign.nameError");
  }
  if (text(form, "confirm") !== "yes") errors.confirm = t("documents.sign.confirmError");
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, typedName };
}

/** The version chain, newest first, from the documents the page has (each names its previous). */
export function versionChain<T extends Pick<DocumentItem, "id" | "previousVersionId">>(
  current: T,
  known: readonly T[],
): T[] {
  const byId = new Map(known.map((d) => [d.id, d]));
  const chain: T[] = [current];
  const seen = new Set([current.id]);
  let previous = current.previousVersionId;
  while (previous && !seen.has(previous)) {
    const found = byId.get(previous);
    if (!found) break;
    chain.push(found);
    seen.add(found.id);
    previous = found.previousVersionId;
  }
  return chain;
}

/** The latest version of each document: those no other document names as its previous. */
export function latestVersions<T extends Pick<DocumentItem, "id" | "previousVersionId">>(
  items: readonly T[],
): T[] {
  const superseded = new Set(
    items.flatMap((d) => (d.previousVersionId ? [d.previousVersionId] : [])),
  );
  return items.filter((d) => !superseded.has(d.id));
}

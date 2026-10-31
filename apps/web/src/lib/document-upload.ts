import type { Translator } from "@harbour/i18n";
import { ORGANISATION_LIMIT, ORGANISATION_LIMIT_MB, TITLE_MAX, TITLE_MIN } from "./documents";
import { isSameOrigin } from "./invitations";

/**
 * Organisation document uploads (PLAT-009) go through their own route handler,
 * `/api/documents/upload`, not a server action, so no other form accepts a large body (ASVS L2
 * input limits). This is its pure part, unit tested: who may post (this site only, by the origin
 * configuration names, never by request headers), what (PDF, the only type organisation documents
 * take) and how much (the API's own limit, checked from Content-Length before reading and counted
 * again while the body streams through).
 */

export const UPLOAD_PATH = "/api/documents/upload";
export const UPLOAD_CONTENT_TYPES: readonly string[] = ORGANISATION_LIMIT.contentTypes;
export const UPLOAD_MAX_BYTES = ORGANISATION_LIMIT.maxBytes;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the upload answers: the stored document, or a refusal the form says in words. */
export type UploadAnswer =
  | { readonly ok: true; readonly data: { readonly id: string } | null }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly fields?: Readonly<Record<string, string>>;
    };

export interface UploadRefusal {
  readonly status: number;
  readonly answer: UploadAnswer;
}

/** This site's origin from configuration (`PUBLIC_WEB_URL`), as the invitation routes read it. */
export function webOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return env.PUBLIC_WEB_URL ?? (env.NODE_ENV === "production" ? null : "http://localhost:3000");
}

function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

const tooLarge = (t: Translator): UploadRefusal => ({
  status: 413,
  answer: {
    ok: false,
    code: "too_large",
    message: t("documents.upload.tooLarge", { mb: ORGANISATION_LIMIT_MB }),
    fields: { file: t("documents.upload.tooLarge", { mb: ORGANISATION_LIMIT_MB }) },
  },
});

/** The size refusal, for a body that turns out larger than it said while it streams. */
export function tooLargeRefusal(t: Translator): UploadRefusal {
  return tooLarge(t);
}

/**
 * Whether a request may be read at all: posted from this site, a PDF, with a length that is
 * given and within the limit. Returns the refusal, or null when it may be read.
 */
export function checkUploadRequest(
  request: {
    readonly origin: string | null;
    readonly contentType: string | null;
    readonly contentLength: string | null;
  },
  configuredOrigin: string | null,
  t: Translator,
): UploadRefusal | null {
  if (!isSameOrigin(request.origin, configuredOrigin)) {
    return {
      status: 403,
      answer: { ok: false, code: "forbidden", message: t("errors.forbidden") },
    };
  }
  if (!UPLOAD_CONTENT_TYPES.includes(mediaType(request.contentType))) {
    const message = t("documents.upload.pdfOnly");
    return {
      status: 415,
      answer: { ok: false, code: "invalid", message, fields: { file: message } },
    };
  }
  const length = request.contentLength === null ? Number.NaN : Number(request.contentLength);
  if (!Number.isInteger(length) || length <= 0) {
    const message = t("documents.upload.fileRequired");
    return {
      status: 411,
      answer: { ok: false, code: "invalid", message, fields: { file: message } },
    };
  }
  if (length > UPLOAD_MAX_BYTES) return tooLarge(t);
  return null;
}

export type UploadTarget =
  | { readonly kind: "new"; readonly title: string; readonly fileName: string | null }
  | { readonly kind: "version"; readonly id: string };

/** What the query string asks for: a new document with its title, or a new version of one. */
export function readUploadTarget(
  params: URLSearchParams,
  t: Translator,
): { ok: true; target: UploadTarget } | { ok: false; refusal: UploadRefusal } {
  const versionOf = params.get("versionOf");
  if (versionOf !== null) {
    if (!UUID.test(versionOf)) {
      return {
        ok: false,
        refusal: {
          status: 404,
          answer: { ok: false, code: "not_found", message: t("errors.notFound") },
        },
      };
    }
    return { ok: true, target: { kind: "version", id: versionOf } };
  }
  const title = (params.get("title") ?? "").replace(/\s+/g, " ").trim();
  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    const message = t("documents.upload.titleError", { min: TITLE_MIN, max: TITLE_MAX });
    return {
      ok: false,
      refusal: {
        status: 400,
        answer: { ok: false, code: "invalid", message, fields: { title: message } },
      },
    };
  }
  const name = params.get("fileName");
  return {
    ok: true,
    target: {
      kind: "new",
      title,
      fileName: name ? (name.split(/[\\/]/).at(-1) ?? "").slice(-255) || null : null,
    },
  };
}

/** Thrown into the stream when the body is larger than allowed; the route answers 413. */
export class UploadTooLarge extends Error {
  constructor() {
    super("upload exceeds the document size limit");
    this.name = "UploadTooLarge";
  }
}

/**
 * Passes the body through, counting bytes, and fails the stream once it passes `limit` (a client
 * may send more than its Content-Length said, or none was enforced on the way): nothing beyond the
 * limit is read or forwarded.
 */
export function countingStream(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new UploadTooLarge());
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

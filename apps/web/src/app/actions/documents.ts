"use server";

import type { DocumentItem } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  DOCUMENTS_PAGE,
  documentPage,
  ORGANISATION_LIMIT_MB,
  readSignature,
  readUpload,
  safeFileName,
} from "@/lib/documents";
import { t } from "@/lib/i18n";
import { type ActionResult, fieldErrors, problemMessage, refused } from "@/lib/outcome";

/**
 * The document library's writes (PLAT-009): upload an organisation document, add a new version
 * (the earlier one is kept) and sign one with a typed name bound to the SHA-256 of the version
 * read. The file passes through as the request body; the web keeps nothing. The API checks the
 * permission, sniffs and scans the file and applies its limits again.
 */

type Api = Awaited<ReturnType<typeof tenantApi>>;

async function send(
  call: (api: Api) => Promise<{ data?: DocumentItem; error?: unknown; response: Response }>,
  paths: readonly string[],
): Promise<ActionResult<{ id: string } | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) {
      if (response.status === 413)
        return refused(t("documents.upload.tooLarge", { mb: ORGANISATION_LIMIT_MB }), "invalid", [
          "file",
        ]);
      return { ok: false, ...problemMessage(error, t) };
    }
    for (const path of paths) revalidatePath(path);
    return { ok: true, data: data ? { id: data.id } : null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** The file as the request body, with its own content type; openapi-fetch sends it untouched. */
function fileBody(file: File) {
  return {
    // The generated client types a binary body as a string; the file is sent as it is, as a Blob,
    // so its own length goes with it.
    body: file as unknown as string,
    bodySerializer: (b: unknown) => b as BodyInit,
    headers: { "content-type": file.type || "application/pdf" },
  };
}

export async function uploadDocument(form: FormData): Promise<ActionResult<{ id: string } | null>> {
  const read = readUpload(form, t, { needsTitle: true });
  if (!read.ok) return fieldErrors(read.errors);
  const file = form.get("file") as File;
  const body = fileBody(file);
  return send(
    (api) =>
      api.POST("/v1/documents", {
        params: {
          query: {
            category: "organisation_document",
            title: read.title,
            fileName: safeFileName(file.name),
          },
        },
        ...body,
      }),
    [DOCUMENTS_PAGE],
  );
}

export async function uploadVersion(
  id: string,
  form: FormData,
): Promise<ActionResult<{ id: string } | null>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  const read = readUpload(form, t, { needsTitle: false });
  if (!read.ok) return fieldErrors(read.errors);
  const body = fileBody(form.get("file") as File);
  return send(
    (api) => api.POST("/v1/documents/{id}/versions", { params: { path: { id } }, ...body }),
    [DOCUMENTS_PAGE, documentPage(id)],
  );
}

export async function signDocument(
  id: string,
  sha256Seen: string,
  form: FormData,
): Promise<ActionResult<{ id: string } | null>> {
  if (!isUuid(id) || !/^[0-9a-f]{64}$/i.test(sha256Seen)) {
    return refused(t("errors.notFound"), "not_found");
  }
  const read = readSignature(form, t);
  if (!read.ok) return fieldErrors(read.errors);
  return send(
    (api) =>
      api.POST("/v1/documents/{id}/signatures", {
        params: { path: { id } },
        body: { typedName: read.typedName, sha256Seen, signerCapacity: "staff" },
      }),
    [documentPage(id)],
  );
}

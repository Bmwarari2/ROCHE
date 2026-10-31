import type { DocumentItem } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import {
  checkUploadRequest,
  countingStream,
  readUploadTarget,
  tooLargeRefusal,
  UPLOAD_MAX_BYTES,
  type UploadAnswer,
  UploadTooLarge,
  webOrigin,
} from "@/lib/document-upload";
import { DOCUMENTS_PAGE, documentPage } from "@/lib/documents";
import { t } from "@/lib/i18n";
import { problemMessage } from "@/lib/outcome";

const headers = { "cache-control": "no-store" } as const;
const answer = (status: number, body: UploadAnswer) => Response.json(body, { status, headers });

function isTooLarge(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (e instanceof UploadTooLarge) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Uploads an organisation document, or a new version of one (PLAT-009). Only this site may post
 * (the origin configuration names, as the invitation routes check; a cross-site form is refused
 * like a server action would be), only a PDF, and no more than the API's limit: the length is
 * checked before anything is read and counted again as the body streams to the API with the
 * person's session. The API checks the permission, sniffs and scans the file again. Server
 * actions keep Next's default body limit; nothing else accepts a large body.
 */
export async function POST(request: Request): Promise<Response> {
  const refusal = checkUploadRequest(
    {
      origin: request.headers.get("origin"),
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
    },
    webOrigin(),
    t,
  );
  if (refusal) return answer(refusal.status, refusal.answer);
  const target = readUploadTarget(new URL(request.url).searchParams, t);
  if (!target.ok) return answer(target.refusal.status, target.refusal.answer);
  if (!request.body)
    return answer(411, { ok: false, code: "invalid", message: t("documents.upload.fileRequired") });

  const body = request.body.pipeThrough(countingStream(UPLOAD_MAX_BYTES));
  const file = {
    // The generated client types a binary body as a string; the stream is sent as it is.
    body: body as unknown as string,
    bodySerializer: (b: unknown) => b as BodyInit,
    headers: { "content-type": "application/pdf" },
    // A streamed request body (fetch requires it for a ReadableStream).
    duplex: "half",
  } as const;
  try {
    const api = await tenantApi();
    const sent: { data?: DocumentItem; error?: unknown; response: Response } =
      target.target.kind === "new"
        ? await api.POST("/v1/documents", {
            params: {
              query: {
                category: "organisation_document",
                title: target.target.title,
                ...(target.target.fileName ? { fileName: target.target.fileName } : {}),
              },
            },
            ...file,
          })
        : await api.POST("/v1/documents/{id}/versions", {
            params: { path: { id: target.target.id } },
            ...file,
          });
    if (!sent.response.ok) {
      if (sent.response.status === 413) {
        const large = tooLargeRefusal(t);
        return answer(large.status, large.answer);
      }
      return answer(sent.response.status, { ok: false, ...problemMessage(sent.error, t) });
    }
    revalidatePath(DOCUMENTS_PAGE);
    if (target.target.kind === "version") revalidatePath(documentPage(target.target.id));
    return answer(201, { ok: true, data: sent.data ? { id: sent.data.id } : null });
  } catch (error) {
    unstable_rethrow(error);
    if (isTooLarge(error)) {
      const large = tooLargeRefusal(t);
      return answer(large.status, large.answer);
    }
    return answer(502, { ok: false, ...problemMessage(undefined, t) });
  }
}

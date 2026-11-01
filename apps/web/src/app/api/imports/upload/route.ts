import { UploadImport } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { countingStream, UploadTooLarge } from "@/lib/document-upload";
import { t } from "@/lib/i18n";
import { checkImportUploadRequest, IMPORT_PAGE, IMPORT_UPLOAD_MAX_BYTES } from "@/lib/imports";
import { isSameOrigin, webOrigin } from "@/lib/invitations";
import { problemMessage } from "@/lib/outcome";

const headers = { "cache-control": "no-store" } as const;
type Answer =
  | { readonly ok: true; readonly data: { readonly id: string } }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly fields?: Readonly<Record<string, string>>;
    };
const answer = (status: number, body: Answer) => Response.json(body, { status, headers });

function isRedirect(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

function isTooLarge(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth += 1) {
    if (e instanceof UploadTooLarge) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Stages an import file (PLAT-014; platform.md rules 18 and 19) through its own route, not a
 * server action, so no other form accepts a large body. Only this site may post, JSON only, no
 * more than the API takes (checked from Content-Length and counted again while reading). The body
 * (the CSV text, the location and the column mapping) goes to the API with the person's session;
 * the API checks the permissions, the organisation-wide scope and every cell. Nothing is kept here
 * and nothing is logged: the file holds people's details.
 */
export async function POST(request: Request): Promise<Response> {
  const refusal = checkImportUploadRequest(
    {
      sameOrigin: isSameOrigin(request.headers.get("origin"), webOrigin()),
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
    },
    t,
  );
  if (refusal)
    return answer(refusal.status, { ok: false, code: refusal.code, message: refusal.message });
  let api: Awaited<ReturnType<typeof tenantApi>>;
  try {
    api = await tenantApi();
  } catch (error) {
    if (isRedirect(error)) {
      return answer(401, { ok: false, code: "unauthenticated", message: t("errors.forbidden") });
    }
    throw error;
  }
  if (!request.body) {
    return answer(411, { ok: false, code: "invalid", message: t("import.upload.fileRequired") });
  }
  let parsed: ReturnType<typeof UploadImport.safeParse>;
  try {
    const text = await new Response(
      request.body.pipeThrough(countingStream(IMPORT_UPLOAD_MAX_BYTES)),
    ).text();
    parsed = UploadImport.safeParse(JSON.parse(text));
  } catch (error) {
    if (isTooLarge(error)) {
      return answer(413, { ok: false, code: "too_large", message: t("import.upload.tooLarge") });
    }
    return answer(400, { ok: false, code: "invalid", message: t("import.upload.notCsv") });
  }
  if (!parsed.success || !parsed.data.csv) {
    return answer(400, { ok: false, code: "invalid", message: t("import.upload.notCsv") });
  }
  try {
    const sent = await api.POST("/v1/imports", { body: parsed.data });
    if (!sent.response.ok || !sent.data) {
      if (sent.response.status === 413) {
        return answer(413, { ok: false, code: "too_large", message: t("import.upload.tooLarge") });
      }
      return answer(sent.response.status, { ok: false, ...problemMessage(sent.error, t) });
    }
    revalidatePath(IMPORT_PAGE);
    return answer(201, { ok: true, data: { id: sent.data.id } });
  } catch (error) {
    unstable_rethrow(error);
    return answer(502, { ok: false, ...problemMessage(undefined, t) });
  }
}

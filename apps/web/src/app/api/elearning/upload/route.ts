import { TRAINING_TOPICS } from "@harbour/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { countingStream, UploadTooLarge } from "@/lib/document-upload";
import {
  checkPackageUpload,
  ELEARNING_PAGE,
  PACKAGE_MAX_BYTES,
  TIER_HEADER,
  TITLE_HEADER,
  TOPIC_HEADER,
} from "@/lib/elearning";
import { t } from "@/lib/i18n";
import { webOrigin } from "@/lib/invitations";
import { problemMessage } from "@/lib/outcome";

const headers = { "cache-control": "no-store" } as const;
const answer = (status: number, body: unknown) => Response.json(body, { status, headers });

function decoded(value: string | null): string | null {
  if (value === null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Adds an e-learning course from a package (ADR-0093). Only this site may post (by its configured
 * origin), only a zip, no more than the category's 100 MB: the length is checked before anything
 * is read and counted again as the body streams to the API with the person's session. The API
 * checks the permission and every archive entry, and scans the package. Titles travel in headers,
 * never the address.
 */
export async function POST(request: Request): Promise<Response> {
  const check = checkPackageUpload(
    {
      origin: request.headers.get("origin"),
      contentType: request.headers.get("content-type"),
      contentLength: request.headers.get("content-length"),
      title: decoded(request.headers.get(TITLE_HEADER)),
      topic: request.headers.get(TOPIC_HEADER),
      tier: request.headers.get(TIER_HEADER),
    },
    webOrigin(),
    TRAINING_TOPICS,
    t,
  );
  if (!check.ok)
    return answer(check.status, { ok: false, code: check.code, message: check.message });
  let api: Awaited<ReturnType<typeof tenantApi>>;
  try {
    api = await tenantApi();
  } catch (error) {
    const digest = (error as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) {
      return answer(401, { ok: false, code: "unauthenticated", message: t("errors.forbidden") });
    }
    throw error;
  }
  if (!request.body) {
    return answer(411, { ok: false, code: "length", message: t("elearning.upload.fileRequired") });
  }
  try {
    const sent = await api.POST("/v1/workforce/elearning/courses", {
      params: {
        query: {
          title: check.title,
          topic: check.topic,
          ...(check.tier ? { tier: check.tier } : {}),
        },
      },
      body: request.body.pipeThrough(countingStream(PACKAGE_MAX_BYTES)) as unknown as string,
      bodySerializer: (b: unknown) => b as BodyInit,
      headers: { "content-type": "application/zip" },
      duplex: "half",
    } as never);
    const result = sent as { data?: { id: string }; error?: unknown; response: Response };
    if (!result.response.ok) {
      if (result.response.status === 413) {
        return answer(413, {
          ok: false,
          code: "too_large",
          message: t("elearning.upload.tooLarge"),
        });
      }
      // The API's own words for a refused package (plain English, no file names or internals).
      const problem = (result.error ?? {}) as { code?: unknown; detail?: unknown };
      if (
        (problem.code === "package_refused" || problem.code === "package_not_scanned") &&
        typeof problem.detail === "string"
      ) {
        return answer(422, { ok: false, code: problem.code, message: problem.detail });
      }
      return answer(result.response.status, { ok: false, ...problemMessage(result.error, t) });
    }
    revalidatePath(ELEARNING_PAGE);
    return answer(201, { ok: true, data: { id: result.data?.id ?? null } });
  } catch (error) {
    unstable_rethrow(error);
    if (
      error instanceof UploadTooLarge ||
      (error as { cause?: unknown })?.cause instanceof UploadTooLarge
    ) {
      return answer(413, { ok: false, code: "too_large", message: t("elearning.upload.tooLarge") });
    }
    return answer(502, { ok: false, ...problemMessage(undefined, t) });
  }
}

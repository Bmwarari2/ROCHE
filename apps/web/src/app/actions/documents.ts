"use server";

import type { DocumentItem } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { documentPage, readSignature } from "@/lib/documents";
import { t } from "@/lib/i18n";
import { type ActionResult, fieldErrors, problemMessage, refused } from "@/lib/outcome";

/**
 * The document library's server action (PLAT-009): sign a document with a typed name bound to the
 * SHA-256 of the version read. Uploads go through `/api/documents/upload`, so server actions keep
 * Next's default body limit. The API checks the permission and every rule again.
 */

type Api = Awaited<ReturnType<typeof tenantApi>>;

async function send(
  call: (api: Api) => Promise<{ data?: DocumentItem; error?: unknown; response: Response }>,
  paths: readonly string[],
): Promise<ActionResult<{ id: string } | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...problemMessage(error, t) };
    for (const path of paths) revalidatePath(path);
    return { ok: true, data: data ? { id: data.id } : null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
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

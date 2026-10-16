"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { EXPORT_PAGE } from "@/lib/exports";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * The full export's writes (PLAT-015): ask for one and cancel one, as the signed-in owner. The API
 * checks `platform.export.create` with step-up and every rule again; the web app keeps nothing.
 */

async function send(
  call: (api: Awaited<ReturnType<typeof tenantApi>>) => Promise<{ ok: boolean; error?: unknown }>,
): Promise<ActionResult<null>> {
  try {
    const { ok, error } = await call(await tenantApi());
    if (!ok) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(EXPORT_PAGE);
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Asks for the organisation's full export; one already being made is the answer if there is one. */
export async function requestExport(): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/exports", { body: {} });
    return { ok: response.ok, error };
  });
}

/** Cancels an export; the worker deletes its archive. */
export async function cancelExport(id: string): Promise<ActionResult<null>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/exports/{id}/revoke", {
      params: { path: { id } },
    });
    return { ok: response.ok, error };
  });
}

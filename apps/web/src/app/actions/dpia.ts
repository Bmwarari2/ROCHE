"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { DPIA_PAGE, type SettingsInput } from "@/lib/dpia";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * The DPIA page's writes (PLAT-023): the governance settings, saving and preparing the open
 * version, and signing it, each as the signed-in person. The API checks the permission, step-up
 * (to sign, and to name a different lead) and every rule again; the web app keeps nothing.
 */

async function send(
  call: (api: ApiClient) => Promise<{ readonly ok: boolean; readonly error?: unknown }>,
): Promise<ActionResult<null>> {
  try {
    const { ok, error } = await call(await tenantApi());
    if (!ok) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(DPIA_PAGE);
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Saves the organisation's data protection governance, naming its lead. */
export async function saveDataProtection(input: SettingsInput): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.PUT("/v1/settings/data-protection", { body: input });
    return { ok: response.ok, error };
  });
}

export interface DraftInput {
  readonly expectedVersion?: number;
  readonly answers: Record<string, Record<string, string>>;
  readonly residualRisk: Record<string, "low" | "medium" | "high" | null>;
  readonly icoReference: string | null;
}

/** Saves the open version's answers and ratings (a new version when none is open). */
export async function saveDpiaDraft(input: DraftInput): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.PUT("/v1/dpia/draft", { body: input });
    return { ok: response.ok, error };
  });
}

/** Marks the open version ready to sign, frozen with its SHA-256. */
export async function prepareDpia(expectedVersion: number): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/dpia/draft/prepare", {
      body: { expectedVersion },
    });
    return { ok: response.ok, error };
  });
}

/** Signs the prepared version as read, by its SHA-256, with the signer's typed name. */
export async function signDpia(
  id: string,
  signature: { readonly typedName: string; readonly sha256Seen: string },
): Promise<ActionResult<null>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  if (signature.typedName.trim().length === 0) {
    return refused(t("dpia.sign.nameRequired"), "invalid", ["typedName"]);
  }
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/dpia/{id}/sign", {
      params: { path: { id } },
      body: signature,
    });
    return { ok: response.ok, error };
  });
}

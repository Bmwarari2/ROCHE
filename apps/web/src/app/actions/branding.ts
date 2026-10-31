"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { BRANDING_PAGE, type BrandingInput, type LOGO_TYPES, logoProblem } from "@/lib/branding";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage } from "@/lib/outcome";

/**
 * The branding page's writes (PLAT-002): the display name and accent, and the logo, each as the
 * signed-in person. The API checks platform.tenant.manage, the accent's contrast and the logo's
 * type, size and malware scan again; the web app keeps nothing. The whole layout is revalidated,
 * so the shell shows the change at once.
 */

async function send(
  call: (api: ApiClient) => Promise<{ readonly ok: boolean; readonly error?: unknown }>,
): Promise<ActionResult<null>> {
  try {
    const { ok, error } = await call(await tenantApi());
    if (!ok) return { ok: false, ...problemMessage(error, t) };
    revalidatePath("/", "layout");
    revalidatePath(BRANDING_PAGE);
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Saves the display name and accent, with the version read. */
export async function saveBranding(input: BrandingInput): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.PUT("/v1/branding", { body: input });
    return { ok: response.ok, error };
  });
}

/** Uploads the logo: the file's bytes are the request body, its type the content type. */
export async function uploadLogo(form: FormData): Promise<ActionResult<null>> {
  const file = form.get("logo");
  const chosen = file instanceof File ? file : null;
  const problem = logoProblem(chosen, t);
  if (problem || !chosen) {
    return { ok: false, code: "invalid", message: problem ?? "", fields: { logo: problem ?? "" } };
  }
  const type = chosen.type as (typeof LOGO_TYPES)[number];
  const bytes = new Uint8Array(await chosen.arrayBuffer());
  let quarantined = false;
  const sent = await send(async (api) => {
    const { response, error, data } = await api.PUT("/v1/branding/logo", {
      // why: the generated type for a binary body is a string; the API reads the raw bytes.
      body: bytes as unknown as string,
      bodySerializer: (body: unknown) => body as BodyInit,
      headers: { "content-type": type },
    });
    // Stored but not shown: it could not be scanned for malware (a quarantined file).
    quarantined = response.ok && data?.status !== "available";
    return { ok: response.ok, error };
  });
  if (sent.ok && quarantined) {
    const message = t("branding.logo.quarantined");
    return { ok: false, code: "quarantined", message, fields: { logo: message } };
  }
  return sent;
}

/** Stops showing the logo; the file stays in the document store under its retention. */
export async function removeLogo(): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.DELETE("/v1/branding/logo");
    return { ok: response.ok, error };
  });
}

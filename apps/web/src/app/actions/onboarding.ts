"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { ONBOARDING_PAGE } from "@/lib/onboarding";
import { type ActionResult, problemMessage } from "@/lib/outcome";

/**
 * The onboarding decisions (PLAT-018; rule 27), as the signed-in holder of
 * platform.onboarding.manage. The API checks each against its rule and records who and when; the
 * web app keeps nothing.
 */

async function send(
  call: (api: ApiClient) => Promise<{ readonly ok: boolean; readonly error?: unknown }>,
): Promise<ActionResult<null>> {
  try {
    const { ok, error } = await call(await tenantApi());
    if (!ok) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(ONBOARDING_PAGE);
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Accepts the setting Harbour chose. */
export async function acceptSetting(rateKey: string): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/onboarding/setting-decisions", {
      body: { rateKey, kind: "accepted" },
    });
    return { ok: response.ok, error };
  });
}

/** Keeps Harbour's period for a kind of record, or says the organisation does not keep it. */
export async function decideRetention(
  recordClass: string,
  kind: "accepted" | "not_used",
): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/onboarding/retention-decisions", {
      body: { recordClass, kind },
    });
    return { ok: response.ok, error };
  });
}

/** Chooses how long staff files are kept, against the organisation record's version. */
export async function chooseStaffFileOption(
  option: "staff_file.after_leaving" | "staff_file.to_75th_birthday",
  expectedVersion: number,
): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.PUT("/v1/onboarding/staff-file-option", {
      body: { option, expectedVersion },
    });
    return { ok: response.ok, error };
  });
}

/** Records the DCB0160 assessment against the release's safety case, as shown. */
export async function recordDcb0160(safetyCaseVersion: string): Promise<ActionResult<null>> {
  return send(async (api) => {
    const { response, error } = await api.POST("/v1/onboarding/dcb0160", {
      body: { safetyCaseVersion },
    });
    return { ok: response.ok, error };
  });
}

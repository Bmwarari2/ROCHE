"use server";

import type { CdRecordingState } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Turns controlled drug recording on or off at a home (H-1517, H-1518; HZ-115, HZ-008), sent to the
 * API as the signed-in person. The API checks the permissions at the home, the second sign-in step
 * and that each step around the change is confirmed, and audits it; nothing is held here.
 */
export type CdRecordingInput =
  | { readonly enabled: true; readonly confirmed: boolean }
  | { readonly enabled: false; readonly reason: string; readonly restarted: boolean };

export async function setCdRecording(
  locationId: string,
  input: CdRecordingInput,
): Promise<ActionResult<CdRecordingState>> {
  if (!isUuid(locationId)) return refused(t("errors.notFound"), "not_found");
  if (input.enabled && !input.confirmed) {
    return refused(t("medicines.cdRecording.confirmRequired", { field: "all" }), "invalid", [
      "closed",
      "carry",
      "phones",
    ]);
  }
  if (!input.enabled) {
    const reason = input.reason.trim();
    if (!reason) return refused(t("medicines.cdRecording.reasonRequired"), "invalid", ["reason"]);
    if (reason.length > 2000) {
      return refused(t("medicines.cdRecording.reasonTooLong"), "invalid", ["reason"]);
    }
    if (!input.restarted) {
      return refused(t("medicines.cdRecording.restartRequired"), "invalid", ["restarted"]);
    }
  }
  try {
    const api = await tenantApi();
    const { data, error } = await api.PUT("/v1/locations/{id}/controlled-drugs/recording", {
      params: { path: { id: locationId } },
      body: input.enabled
        ? {
            enabled: true,
            paperRegisterClosed: true,
            balancesToCarryForward: true,
            phonesUpdated: true,
          }
        : { enabled: false, reason: input.reason.trim(), paperRegisterRestarted: true },
    });
    if (data) {
      revalidatePath(`/medicines-settings/${locationId}`);
      return { ok: true, data };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

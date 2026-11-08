"use server";

import type { DeviceRevocationReason, RevokeDeviceResult } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isWithdrawReason } from "@/lib/care-devices";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Withdraws a lost or replaced Care mode phone (HZ-040, HZ-006), sent to the API as the signed-in
 * manager. The API checks the permission, the second sign-in step and who used the phone, refuses
 * a phone with entries waiting until the manager confirms them (409 `entries_waiting`), and
 * audits it; nothing is held here.
 */
export async function withdrawDevice(
  deviceId: string,
  input: { readonly reasonCode: string; readonly confirmEntriesWaiting: boolean },
): Promise<ActionResult<RevokeDeviceResult>> {
  if (!isUuid(deviceId)) return refused(t("errors.notFound"), "not_found");
  if (!isWithdrawReason(input.reasonCode)) {
    return refused(t("devices.withdraw.reasonRequired"), "invalid", ["reason"]);
  }
  try {
    const api = await tenantApi();
    const { data, error } = await api.POST("/v1/devices/{deviceId}/revoke", {
      params: { path: { deviceId } },
      body: {
        reasonCode: input.reasonCode as DeviceRevocationReason,
        ...(input.confirmEntriesWaiting ? { confirmEntriesWaiting: true } : {}),
      },
    });
    if (data) {
      revalidatePath("/settings/devices");
      revalidatePath(`/settings/devices/${deviceId}`);
      return { ok: true, data };
    }
    // Entries reported since the page loaded: the manager is asked to confirm them, in words
    // tied to the box, never told to try again (accessibility review H1).
    if ((error as { code?: unknown } | undefined)?.code === "entries_waiting") {
      return refused(t("devices.withdraw.entriesArrived"), "entries_waiting", ["confirm"]);
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

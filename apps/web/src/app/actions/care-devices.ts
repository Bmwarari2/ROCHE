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
  input: {
    readonly reasonCode: string;
    /** What the manager saw: the count and when the phone reported it (null when it never did). */
    readonly seen: { readonly count: number; readonly reportedAt: string | null };
  },
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
        confirmedEntriesWaiting: { count: input.seen.count, reportedAt: input.seen.reportedAt },
      },
    });
    if (data) {
      revalidatePath("/settings/devices");
      revalidatePath(`/settings/devices/${deviceId}`);
      return { ok: true, data };
    }
    // What the phone reported changed since the page loaded (a different count or report, H-1535):
    // the manager reloads and confirms it, in words tied to the box, never told to try again.
    if ((error as { code?: unknown } | undefined)?.code === "entries_waiting") {
      return refused(t("devices.withdraw.entriesArrived"), "entries_waiting", ["confirm"]);
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

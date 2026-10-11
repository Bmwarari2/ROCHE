"use server";

import { revalidatePath } from "next/cache";
import { problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { BREAK_GLASS_MIN_LENGTH } from "@/lib/people";

export type BreakGlassOutcome =
  | { readonly ok: true; readonly expiresAt: string }
  | {
      readonly ok: false;
      readonly reason: "step-up" | "forbidden" | "not-found" | "too-short" | "unavailable";
    };

/**
 * Opens a record outside the person's access with a written reason (section 4). The API checks
 * the permission and a fresh sign-in, alerts the Registered Manager and the data protection lead,
 * and audits the reason.
 */
export async function openBreakGlass(
  personId: string,
  justification: string,
): Promise<BreakGlassOutcome> {
  if (!isUuid(personId)) return { ok: false, reason: "not-found" };
  const reason = justification.trim();
  if (reason.length < BREAK_GLASS_MIN_LENGTH) return { ok: false, reason: "too-short" };

  const api = await tenantApi();
  const { data, error } = await api.POST("/v1/people/break-glass", {
    body: { personId, justification: reason },
  });
  if (data) {
    revalidatePath(`/people/${personId}`);
    return { ok: true, expiresAt: data.expiresAt };
  }
  switch (problemCode(error)) {
    case "step_up_required":
      return { ok: false, reason: "step-up" };
    case "missing_permission":
    case "mfa_enrolment_required":
      return { ok: false, reason: "forbidden" };
    case "not_found":
      return { ok: false, reason: "not-found" };
    case "invalid":
      return { ok: false, reason: "too-short" };
    default:
      return { ok: false, reason: "unavailable" };
  }
}

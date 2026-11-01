"use server";

import { revalidatePath } from "next/cache";
import { problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { justificationProblem } from "@/lib/people";
import { BREAK_GLASS_REASON_CODES } from "@/lib/search";

export type BreakGlassOutcome =
  | { readonly ok: true; readonly expiresAt: string }
  | {
      readonly ok: false;
      readonly reason:
        | "step-up"
        | "forbidden"
        | "not-found"
        | "too-short"
        | "too-long"
        | "unavailable";
    };

/**
 * Opens a record outside the person's access with a written reason (section 4). The API checks
 * the permission and a fresh sign-in, alerts the Registered Manager and the data protection lead,
 * and audits the reason.
 */
export async function openBreakGlass(
  personId: string,
  justification: string,
  reasonCode?: string,
): Promise<BreakGlassOutcome> {
  if (!isUuid(personId)) return { ok: false, reason: "not-found" };
  const reason = justification.trim();
  const problem = justificationProblem(reason);
  if (problem) return { ok: false, reason: problem };

  const api = await tenantApi();
  const { data, error } = await api.POST("/v1/people/break-glass", {
    body: {
      personId,
      justification: reason,
      // The weekly report counts openings by the reason chosen (PLAT-006); an unknown code is left out.
      ...(reasonCode && (BREAK_GLASS_REASON_CODES as readonly string[]).includes(reasonCode)
        ? { reasonCode: reasonCode as (typeof BREAK_GLASS_REASON_CODES)[number] }
        : {}),
    },
  });
  if (data) {
    revalidatePath(`/people/${personId}`);
    return { ok: true, expiresAt: data.expiresAt };
  }
  switch (problemCode(error)) {
    case "step_up_required":
    case "mfa_verification_required":
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

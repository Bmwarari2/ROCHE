"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { type InviteInput, teamRefusal } from "@/lib/team";

/**
 * The managers' team writes (PLAT-004): add a member and invite them, send an invitation again,
 * withdraw one. Sent to the API as the signed-in person, which checks `platform.user.manage`,
 * step-up, its reach and every rule again; the web app keeps nothing. A new member carries the
 * form's id, so a retry after a lost reply adds nobody twice.
 */

type Sent = { readonly memberId: string; readonly emailSent: boolean };

function teamProblem(error: unknown): ActionResult<never> {
  const code = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown };
  const words = teamRefusal(code.code, t);
  if (words) {
    const field =
      code.code === "email_in_use" ? ["email"] : code.code === "beyond_inviter" ? ["roleId"] : [];
    return refused(words, String(code.code), field.length > 0 ? field : undefined);
  }
  return { ok: false, ...problemMessage(error, t) };
}

async function withApi<T>(fn: (api: ApiClient) => Promise<ActionResult<T>>) {
  try {
    return await fn(await tenantApi());
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, ...problemMessage(undefined, t) };
  }
}

async function invite(api: ApiClient, memberId: string): Promise<ActionResult<Sent>> {
  const { data, error } = await api.POST("/v1/invitations", { body: { tenantUserId: memberId } });
  if (!data) return teamProblem(error);
  revalidatePath("/settings/team", "layout");
  return { ok: true, data: { memberId, emailSent: data.emailSent } };
}

/** Adds the member as invited with one role, then emails their invitation. */
export async function addAndInvite(input: InviteInput): Promise<ActionResult<Sent>> {
  if (!isUuid(input.id)) return refused(t("errors.notFound"), "not_found");
  return withApi(async (api) => {
    const { data, error } = await api.POST("/v1/members", { body: input });
    if (!data) return teamProblem(error);
    return invite(api, data.id);
  });
}

/** Sends a new invitation; any link sent before stops working. */
export async function resendInvitation(memberId: string): Promise<ActionResult<Sent>> {
  if (!isUuid(memberId)) return refused(t("errors.notFound"), "not_found");
  return withApi((api) => invite(api, memberId));
}

/** Withdraws an open invitation: its link stops working at once. */
export async function revokeInvitation(invitationId: string): Promise<ActionResult<null>> {
  if (!isUuid(invitationId)) return refused(t("errors.notFound"), "not_found");
  return withApi<null>(async (api) => {
    const { error, response } = await api.POST("/v1/invitations/{id}/revoke", {
      params: { path: { id: invitationId } },
    });
    if (!response.ok) return teamProblem(error);
    revalidatePath("/settings/team", "layout");
    return { ok: true, data: null };
  });
}

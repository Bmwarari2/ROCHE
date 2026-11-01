"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { dataProtectionProblem } from "@/lib/data-protection-refusals";
import { COMPLAINTS_PAGE } from "@/lib/data-rights";
import { type Complaint, complaintPath } from "@/lib/dp-complaints";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * The data protection complaints' writes (PLAT-022; platform.md rule 25), each as the signed-in
 * person. The API checks the permission across the organisation, the dates, the version and the
 * closure rules again; the web app keeps nothing.
 */

type Sent<T> = { readonly ok: boolean; readonly error?: unknown; readonly data?: T };

async function send<T>(
  id: string | null,
  call: (api: ApiClient) => Promise<Sent<T>>,
): Promise<ActionResult<T | null>> {
  if (id !== null && !isUuid(id)) return refused(t("errors.notFound"), "not_found");
  try {
    const { ok, error, data } = await call(await tenantApi());
    if (!ok) return { ok: false, ...dataProtectionProblem(error, t) };
    revalidatePath(COMPLAINTS_PAGE);
    if (id) revalidatePath(complaintPath(id));
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...dataProtectionProblem(undefined, t) };
  }
}

export interface RecordComplaintInput {
  readonly receivedOn: string;
  readonly channel: Complaint["channel"];
  readonly complainantKind: Complaint["complainantKind"];
  readonly complainantName: string;
  readonly complainantContact: string | null;
  readonly about: Complaint["about"];
  readonly summary: string;
}

/** Records a data protection complaint received by any channel. */
export async function recordComplaint(
  input: RecordComplaintInput,
): Promise<ActionResult<{ readonly id: string } | null>> {
  return send(null, async (api) => {
    const { response, error, data } = await api.POST("/v1/data-protection/complaints", {
      body: input,
    });
    return { ok: response.ok, error, ...(data ? { data: { id: data.id } } : {}) };
  });
}

/** Records the day the complaint was acknowledged, or a day the complainant was updated. */
export async function recordComplaintDate(
  id: string,
  which: "acknowledge" | "contact",
  input: { readonly expectedVersion: number; readonly on: string },
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } =
      which === "acknowledge"
        ? await api.POST("/v1/data-protection/complaints/{id}/acknowledge", {
            params: { path: { id } },
            body: input,
          })
        : await api.POST("/v1/data-protection/complaints/{id}/contact", {
            params: { path: { id } },
            body: input,
          });
    return { ok: response.ok, error };
  });
}

/** Closes the complaint with its outcome, which tells the complainant they can go to the ICO. */
export async function closeComplaint(
  id: string,
  input: {
    readonly expectedVersion: number;
    readonly closedOn: string;
    readonly outcome: string;
    readonly icoRightStated: boolean;
  },
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } = await api.POST("/v1/data-protection/complaints/{id}/close", {
      params: { path: { id } },
      body: input,
    });
    return { ok: response.ok, error };
  });
}

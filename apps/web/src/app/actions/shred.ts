"use server";

import {
  CreateShredRequest,
  RefuseShredRequest,
  type ShredApproved,
  type ShredRequestItem,
} from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { RETENTION_PAGE } from "@/lib/retention";
import { SHRED_PAGE, shredHref } from "@/lib/shred";

/**
 * Whole-organisation shredding writes (PLAT-012 part 2; platform.md rules 7 to 10): ask, approve,
 * refuse, cancel or withdraw. The API needs `platform.retention.manage` tenant-wide with a fresh
 * step-up for each, and decides every rule again (two people, 7 days, the export, legal holds);
 * the web keeps nothing.
 */

type Api = Awaited<ReturnType<typeof tenantApi>>;

async function send<T>(
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
  id?: string,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...shredProblem(error) };
    revalidatePath(SHRED_PAGE);
    revalidatePath(RETENTION_PAGE);
    if (id) revalidatePath(shredHref(id));
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");

/** The shred routes' refusals, in the catalogue's words (`shred.refusal`); others as usual. */
const SHRED_CODES = new Set([
  "same_person",
  "not_requester",
  "not_pending",
  "expired",
  "requester_ineligible",
  "legal_hold_active",
  "already_pending",
  "export_not_downloaded",
  "reason_too_short",
]);

function shredProblem(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (!SHRED_CODES.has(code)) return problemMessage(error, t);
  const message = t("shred.refusal", { code });
  return code === "reason_too_short"
    ? { code, message, fields: { reason: message } }
    : { code, message };
}

export async function requestShred(body: {
  readonly reason: string;
  readonly exportId: string;
}): Promise<ActionResult<ShredRequestItem | null>> {
  const parsed = CreateShredRequest.safeParse(body);
  if (!parsed.success || !isUuid(body.exportId)) return notFound();
  return send((api) => api.POST("/v1/retention/shred-requests", { body: parsed.data }));
}

export async function approveShred(id: string): Promise<ActionResult<ShredApproved | null>> {
  if (!isUuid(id)) return notFound();
  return send(
    (api) => api.POST("/v1/retention/shred-requests/{id}/approve", { params: { path: { id } } }),
    id,
  );
}

export async function refuseShred(
  id: string,
  reason: string,
): Promise<ActionResult<ShredRequestItem | null>> {
  const parsed = RefuseShredRequest.safeParse({ reason });
  if (!isUuid(id) || !parsed.success) return notFound();
  return send(
    (api) =>
      api.POST("/v1/retention/shred-requests/{id}/refuse", {
        params: { path: { id } },
        body: parsed.data,
      }),
    id,
  );
}

export async function cancelShred(id: string): Promise<ActionResult<ShredRequestItem | null>> {
  if (!isUuid(id)) return notFound();
  return send(
    (api) => api.POST("/v1/retention/shred-requests/{id}/cancel", { params: { path: { id } } }),
    id,
  );
}

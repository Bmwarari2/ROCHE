"use server";

import type { DestructionResult, LegalHoldItem, PlaceLegalHold } from "@harbour/contracts";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { DESTROY_MAX, RETENTION_PAGE } from "@/lib/retention";

/**
 * Records retention writes (PLAT-012): place and release legal holds, and destroy documents past
 * retention. The API needs `platform.retention.manage` with a fresh step-up for each, re-checks
 * every id before destroying (held, not yet due or unknown ids are skipped) and writes the
 * destruction certificates; the web keeps nothing.
 */

type Api = Awaited<ReturnType<typeof tenantApi>>;

async function send<T>(
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(RETENTION_PAGE);
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");

export async function placeHold(body: PlaceLegalHold): Promise<ActionResult<LegalHoldItem | null>> {
  if (body.personId !== undefined && !isUuid(body.personId)) return notFound();
  if (body.subjectId !== undefined && !isUuid(body.subjectId)) return notFound();
  return send((api) => api.POST("/v1/legal-holds", { body }));
}

export async function releaseHold(input: {
  readonly id: string;
  readonly version: number;
  readonly reason: string;
}): Promise<ActionResult<LegalHoldItem | null>> {
  if (!isUuid(input.id) || !Number.isInteger(input.version) || input.version < 1) {
    return notFound();
  }
  return send((api) =>
    api.POST("/v1/legal-holds/{id}/release", {
      params: { path: { id: input.id } },
      body: { reason: input.reason, version: input.version },
    }),
  );
}

export async function destroyDocuments(input: {
  readonly documentIds: readonly string[];
  readonly reason: string;
}): Promise<ActionResult<DestructionResult | null>> {
  const ids = [...new Set(input.documentIds)];
  if (ids.length === 0 || ids.length > DESTROY_MAX || !ids.every(isUuid)) return notFound();
  return send((api) =>
    api.POST("/v1/retention/destroy", { body: { documentIds: ids, reason: input.reason } }),
  );
}

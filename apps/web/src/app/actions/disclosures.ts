"use server";

import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import type { ItemDecisionBody, LogRequestBody } from "@/lib/disclosures";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Writes for the disclosure request screens (Phase 2 slice 63; SAFE-016). The API checks the
 * permission where the person is, the legal basis, that the approver did not prepare the request,
 * and a fresh step-up to release; the web keeps nothing of its own.
 */

const notFound = () => refused(t("errors.notFound"), "not_found");
const paths = (id?: string) => ["/disclosures", ...(id ? [`/disclosures/${id}`] : [])];

export async function logDisclosureRequest(
  body: LogRequestBody,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(body.personId)) return refused(t("care.errors.invalid"));
  return sendAndRevalidate(paths(), async (api) => {
    const { data, error } = await api.POST("/v1/disclosures", { body });
    return { ...(data ? { data: { id: data.id } } : {}), error };
  });
}

export async function collectDisclosure(id: string): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/collect", { params: { path: { id } } }),
  );
}

export async function decideDisclosureItem(
  id: string,
  itemId: string,
  body: ItemDecisionBody,
): Promise<ActionResult<unknown>> {
  if (!isUuid(id) || !isUuid(itemId)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/items/{itemId}/decision", {
      params: { path: { id, itemId } },
      body,
    }),
  );
}

export async function prepareDisclosure(
  id: string,
  body: { expectedVersion: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/prepare", { params: { path: { id } }, body }),
  );
}

export async function decideDisclosure(
  id: string,
  body: { decision: "approve" | "refuse"; reason?: string; expectedVersion: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate([...paths(id), "/approvals"], (api) =>
    api.POST("/v1/disclosures/{id}/decision", { params: { path: { id } }, body }),
  );
}

export async function releaseDisclosure(
  id: string,
  body: { expectedVersion: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/release", { params: { path: { id } }, body }),
  );
}

export async function recordDisclosureHandOver(
  id: string,
  body: {
    route: "secure_portal" | "secure_email" | "encrypted_media" | "in_person" | "recorded_delivery";
    at: string;
    reference: string | null;
    expectedVersion: number;
  },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/hand-over", { params: { path: { id } }, body }),
  );
}

export async function withdrawDisclosure(
  id: string,
  body: { reason: string; expectedVersion: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/withdraw", { params: { path: { id } }, body }),
  );
}

export async function recordPreventionReport(
  id: string,
  body: { reportOn: string; respondedOn?: string | null; expectedVersion: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(paths(id), (api) =>
    api.POST("/v1/disclosures/{id}/prevention-report", { params: { path: { id } }, body }),
  );
}

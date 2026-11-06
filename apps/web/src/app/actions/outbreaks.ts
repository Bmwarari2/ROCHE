"use server";

import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import type { OutbreakSyndrome, RecordCaseBody } from "@/lib/outbreaks";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Writes for the outbreak screens (Phase 2 slice 63; SAFE-013). The API checks
 * `safety.outbreak.manage` where the outbreak is and every rule; the web keeps nothing.
 */

export async function declareOutbreak(body: {
  locationId: string;
  syndrome: OutbreakSyndrome;
  organism?: string;
  hptReference?: string;
}): Promise<ActionResult<unknown>> {
  if (!isUuid(body.locationId)) return refused(t("care.errors.invalid"));
  return sendAndRevalidate(["/outbreaks"], (api) => api.POST("/v1/safety/outbreaks", { body }));
}

export async function updateOutbreak(
  id: string,
  body: { version: number; organism: string | null; hptReference: string | null },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/outbreaks"], (api) =>
    api.PUT("/v1/safety/outbreaks/{id}", { params: { path: { id } }, body }),
  );
}

export async function recordOutbreakCase(
  id: string,
  body: RecordCaseBody,
): Promise<ActionResult<unknown>> {
  if (!isUuid(id) || !isUuid(body.personId)) return refused(t("care.errors.invalid"));
  return sendAndRevalidate(["/outbreaks"], (api) =>
    api.POST("/v1/safety/outbreaks/{id}/cases", {
      params: { path: { id } },
      body: { ...body, symptoms: [...body.symptoms] },
    }),
  );
}

export async function closeOutbreak(
  id: string,
  body: { version: number; closedOn: string; reason: string },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/outbreaks", "/notifications/statutory"], (api) =>
    api.POST("/v1/safety/outbreaks/{id}/close", { params: { path: { id } }, body }),
  );
}

"use server";

import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import type { HerbertBody, OpenEpisodeBody, TimelineBody } from "@/lib/missing";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Writes for the missing person screens and the Herbert Protocol profile (Phase 2 slice 63;
 * SAFE-015). The API checks the permission where the person is, the police call target and what
 * closing needs; the web holds nothing of its own. Episode and timeline ids are made by the form,
 * so a retry after an unknown outcome is a no-op.
 */

export async function openMissingEpisode(
  body: OpenEpisodeBody,
): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(body.id) || !isUuid(body.incidentId) || !isUuid(body.personId)) {
    return refused(t("care.errors.invalid"));
  }
  return sendAndRevalidate(["/missing", `/incidents/${body.incidentId}`], (api) =>
    api.POST("/v1/missing-episodes", { body: { ...body } }),
  );
}

export async function addMissingEvent(
  id: string,
  body: TimelineBody,
): Promise<ActionResult<unknown>> {
  if (!isUuid(id) || !isUuid(body.id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/missing"], (api) =>
    api.POST("/v1/missing-episodes/{id}/events", { params: { path: { id } }, body: { ...body } }),
  );
}

export async function closeMissingEpisode(
  id: string,
  version: number,
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/missing"], (api) =>
    api.POST("/v1/missing-episodes/{id}/close", { params: { path: { id } }, body: { version } }),
  );
}

export async function saveHerbertProfile(
  personId: string,
  body: HerbertBody,
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate([`/people/${personId}/herbert`, "/missing"], (api) =>
    api.PUT("/v1/people/{id}/herbert-profile", {
      params: { path: { id: personId } },
      body: { ...body },
    }),
  );
}

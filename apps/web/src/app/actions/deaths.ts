"use server";

import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import type { DeathStepKey } from "@/lib/deaths";
import { recordableHere } from "@/lib/deaths";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * Writes for the death record screens (Phase 2 slice 63; SAFE-014). The API checks
 * safety.incident.manage where the record is and every rule; the notification steps are never
 * recorded from here (the notification centre completes them).
 */

const notFound = () => refused(t("errors.notFound"), "not_found");

export async function openDeathRecord(exitRecordId: string): Promise<ActionResult<{ id: string }>> {
  if (!isUuid(exitRecordId)) return refused(t("deaths.new.noExitRecord"));
  return sendAndRevalidate(["/deaths"], (api) =>
    api.POST("/v1/deaths", { body: { exitRecordId } }),
  );
}

export async function recordJudgement(
  id: string,
  body: { expected: boolean; possiblyUnnatural: boolean; judgedBy: string; version: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(["/deaths"], (api) =>
    api.PUT("/v1/deaths/{id}", { params: { path: { id } }, body }),
  );
}

export async function recordDeathStep(
  id: string,
  body: {
    id: string;
    step: DeathStepKey;
    outcome: "done" | "not_needed";
    at: string;
    note: string | null;
    reference: string | null;
  },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id) || !isUuid(body.id)) return notFound();
  if (!recordableHere(body.step)) return refused(t("deaths.step.notHere"));
  return sendAndRevalidate(["/deaths"], (api) =>
    api.POST("/v1/deaths/{id}/steps", { params: { path: { id } }, body }),
  );
}

export async function recordDeathReview(
  id: string,
  body: { findings: string; lessons: string; version: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(["/deaths"], (api) =>
    api.PUT("/v1/deaths/{id}/review", { params: { path: { id } }, body }),
  );
}

export async function closeDeathRecord(
  id: string,
  body: { version: number },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return notFound();
  return sendAndRevalidate(["/deaths"], (api) =>
    api.POST("/v1/deaths/{id}/close", { params: { path: { id } }, body }),
  );
}

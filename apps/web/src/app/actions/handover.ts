"use server";

import type { HandoverDetail } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Shift handover writes (care.md rule 14; COMMS-006): compiling, a note on the handover or one of
 * its items, and acknowledging it as read. The API checks `care.handover.manage` where the
 * location is and every rule again; notes and acknowledgements carry the form's UUIDv7, so a
 * retry after a lost reply is recorded once (HZ-029).
 */

type Outcome = ActionResult<HandoverDetail>;

function handoverProblem(error: unknown): Outcome {
  const problem = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    detail?: unknown;
    title?: unknown;
  };
  // The handover changed since it was read, or compiling was asked for too often: in words.
  if (problem.code === "handover_changed") {
    return refused(t("care.handover.changed"), "handover_changed");
  }
  if (problem.code === "rate_limited") return refused(t("care.handover.tooOften"), "rate_limited");
  return { ok: false, ...problemMessage(error, t) };
}

async function send(
  locationId: string,
  call: (api: ApiClient) => Promise<{ data?: unknown; error?: unknown }>,
): Promise<Outcome> {
  if (!isUuid(locationId)) return refused(t("errors.notFound"), "not_found");
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath(`/handover/${locationId}`, "layout");
      return { ok: true, data: data as HandoverDetail };
    }
    return handoverProblem(error);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Compiles the shift running now, or adds what has appeared since it was compiled. */
export async function compileHandover(locationId: string): Promise<Outcome> {
  return send(locationId, (api) =>
    api.POST("/v1/locations/{id}/handovers", {
      params: { path: { id: locationId } },
      body: {},
    }),
  );
}

export async function addHandoverNote(
  locationId: string,
  handoverId: string,
  input: { readonly id: string; readonly itemKey: string | null; readonly body: string },
): Promise<Outcome> {
  if (!isUuid(handoverId) || !isUuid(input.id)) return refused(t("errors.notFound"), "not_found");
  const body = input.body.trim();
  if (!body) return refused(t("care.handover.noteRequired"), "invalid", ["body"]);
  if (body.length > 2000) return refused(t("care.handover.noteTooLong"), "invalid", ["body"]);
  return send(locationId, (api) =>
    api.POST("/v1/locations/{id}/handovers/{handoverId}/notes", {
      params: { path: { id: locationId, handoverId } },
      body: { id: input.id, body, ...(input.itemKey ? { itemKey: input.itemKey } : {}) },
    }),
  );
}

export async function acknowledgeHandover(
  locationId: string,
  handoverId: string,
  input: { readonly id: string; readonly seenToken: string },
): Promise<Outcome> {
  if (!isUuid(handoverId) || !isUuid(input.id)) return refused(t("errors.notFound"), "not_found");
  return send(locationId, (api) =>
    api.POST("/v1/locations/{id}/handovers/{handoverId}/acknowledgements", {
      params: { path: { id: locationId, handoverId } },
      body: { id: input.id, seenToken: input.seenToken.slice(0, 128) },
    }),
  );
}

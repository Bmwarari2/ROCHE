"use server";

import type {
  AnonymousSpeakUpRaised,
  CreateComplaint,
  CreateCompliment,
  RaiseSafeguardingConcern,
  RaiseSpeakUp,
  SafeguardingState,
  SpeakUpCategory,
  SpeakUpState,
  SpeakUpThread,
  UpdateSafeguardingConcern,
} from "@harbour/contracts";
import { headers } from "next/headers";
import { API_URL } from "@/lib/api";
import { sendAndRevalidate } from "@/lib/care-actions";
import { clientAddress, trustedProxies } from "@/lib/client-address";
import type { ComplaintStepBody } from "@/lib/complaints";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { isOrganisationId, isReplyToken } from "@/lib/speak-up";

/**
 * Writes for the safeguarding, complaints and speak-up screens (Phase 2 slice 62). The API checks
 * each permission where the record is, every rule and the speak-up silo; the web keeps nothing of
 * its own. The public speak-up calls carry no session and pass on only the client address, which
 * the API needs for its per-network limit and keeps only as a keyed hash (ADR-0089).
 */

// ---- Complaints and compliments --------------------------------------------------------------

export async function recordComplaint(body: CreateComplaint): Promise<ActionResult<unknown>> {
  if (!body.id || !isUuid(body.id) || !isUuid(body.locationId)) {
    return refused(t("care.errors.invalid"));
  }
  return sendAndRevalidate(["/complaints"], (api) => api.POST("/v1/complaints", { body }));
}

export async function stepComplaint(
  id: string,
  body: ComplaintStepBody,
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/complaints", "/approvals"], (api) =>
    api.POST("/v1/complaints/{id}/step", { params: { path: { id } }, body }),
  );
}

export async function recordCompliment(body: CreateCompliment): Promise<ActionResult<unknown>> {
  if (!body.id || !isUuid(body.id) || !isUuid(body.locationId)) {
    return refused(t("care.errors.invalid"));
  }
  return sendAndRevalidate(["/complaints/compliments"], (api) =>
    api.POST("/v1/compliments", { body }),
  );
}

// ---- Safeguarding ----------------------------------------------------------------------------

export async function raiseSafeguardingConcern(
  body: RaiseSafeguardingConcern,
): Promise<ActionResult<{ id: string }>> {
  if (!body.id || !isUuid(body.id) || !isUuid(body.personId)) {
    return refused(t("care.errors.invalid"));
  }
  return sendAndRevalidate(["/safeguarding", `/people/${body.personId}`], (api) =>
    api.POST("/v1/safeguarding/concerns", { body }),
  );
}

export async function updateSafeguardingConcern(
  id: string,
  body: UpdateSafeguardingConcern,
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/safeguarding"], (api) =>
    api.PUT("/v1/safeguarding/concerns/{id}", { params: { path: { id } }, body }),
  );
}

export async function stepSafeguardingConcern(
  id: string,
  body: { to: SafeguardingState; version: number; reason?: string },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/safeguarding", "/approvals"], (api) =>
    api.POST("/v1/safeguarding/concerns/{id}/step", { params: { path: { id } }, body }),
  );
}

// ---- Speak-up (signed in) --------------------------------------------------------------------

export async function raiseSpeakUp(body: RaiseSpeakUp): Promise<ActionResult<SpeakUpThread>> {
  if (!body.id || !isUuid(body.id)) return refused(t("care.errors.invalid"));
  return sendAndRevalidate(["/speak-up"], (api) => api.POST("/v1/speak-up", { body }));
}

export async function replyToMyConcern(
  id: string,
  body: string,
): Promise<ActionResult<SpeakUpThread>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/speak-up"], (api) =>
    api.POST("/v1/speak-up/mine/{id}/messages", { params: { path: { id } }, body: { body } }),
  );
}

export async function writeOnCase(id: string, body: string): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/speak-up/cases"], (api) =>
    api.POST("/v1/speak-up/cases/{id}/messages", { params: { path: { id } }, body: { body } }),
  );
}

export async function stepSpeakUpCase(
  id: string,
  body: { to: SpeakUpState; version: number; outcome?: string; reason?: string },
): Promise<ActionResult<unknown>> {
  if (!isUuid(id)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(["/speak-up/cases"], (api) =>
    api.POST("/v1/speak-up/cases/{id}/step", { params: { path: { id } }, body }),
  );
}

export async function setSpeakUpMembers(
  id: string,
  memberIds: readonly string[],
): Promise<ActionResult<unknown>> {
  if (!isUuid(id) || !memberIds.every(isUuid)) return refused(t("care.errors.invalid"));
  return sendAndRevalidate(["/speak-up/cases"], (api) =>
    api.PUT("/v1/speak-up/cases/{id}/members", {
      params: { path: { id } },
      body: { memberIds: [...memberIds] },
    }),
  );
}

// ---- Speak-up (public, no session) -----------------------------------------------------------

const TRUSTED_PROXIES = trustedProxies(process.env.TRUSTED_PROXY_CIDRS);

/** Only the client address (for the API's per-network limit): no cookie, agent or request id. */
async function publicHeaders(): Promise<Record<string, string>> {
  const address = clientAddress((await headers()).get("x-forwarded-for"), TRUSTED_PROXIES);
  return { "content-type": "application/json", ...(address ? { "x-forwarded-for": address } : {}) };
}

async function publicPost<T>(path: string, body: object): Promise<ActionResult<T>> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: await publicHeaders(),
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await response.json().catch(() => undefined)) as unknown;
    if (response.ok) return { ok: true, data: json as T };
    return { ok: false, ...problemMessage(json, t) };
  } catch {
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export async function raiseAnonymousConcern(
  tenantId: string,
  body: { category: SpeakUpCategory; summary: string; wantsReplies: boolean },
): Promise<ActionResult<AnonymousSpeakUpRaised>> {
  if (!isOrganisationId(tenantId)) return refused(t("errors.notFound"), "not_found");
  return publicPost(`/p/speak-up/${tenantId}`, body);
}

export async function readAnonymousThread(
  tenantId: string,
  replyToken: string,
): Promise<ActionResult<SpeakUpThread>> {
  if (!isOrganisationId(tenantId) || !isReplyToken(replyToken)) {
    return refused(t("speakUp.anonymous.tokenError"), "invalid", ["replyToken"]);
  }
  return publicPost(`/p/speak-up/${tenantId}/thread`, { replyToken });
}

export async function replyAnonymously(
  tenantId: string,
  replyToken: string,
  body: string,
): Promise<ActionResult<SpeakUpThread>> {
  if (!isOrganisationId(tenantId) || !isReplyToken(replyToken)) {
    return refused(t("speakUp.anonymous.tokenError"), "invalid", ["replyToken"]);
  }
  return publicPost(`/p/speak-up/${tenantId}/messages`, { replyToken, body });
}

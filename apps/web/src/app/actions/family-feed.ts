"use server";

import type { FeedPreview } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  CONFIRMATION_MAX,
  FEED_SOURCE_KINDS,
  FEED_TEXT_MAX,
  FEED_WITHDRAWAL_REASONS,
  type FeedWithdrawalReason,
  type PublishSource,
} from "@/lib/family-feed";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Family update writes (comms.md rules 6 to 12; COMMS-001; HZ-022, HZ-060, HZ-061), sent to the
 * API as the signed-in member of staff. The API composes the update, checks the words, the holds
 * and the photo's basis, and refuses anything it would not publish; the web holds nothing.
 */

/**
 * A refusal in words. A conflict is, when publishing, the form's id used for another record (so
 * nothing was published twice) and, when withdrawing, an update already taken down.
 */
function feedProblem(error: unknown, conflict: string): ActionResult<never> {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "conflict") return refused(conflict, "conflict");
  return { ok: false, ...problemMessage(error, t) };
}

async function send<T>(
  personId: string,
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
  conflict = t("comms.feed.publish.conflict"),
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error, response } = await call(api);
    // Taking an update down answers 204 with no body: success is the status, not the data.
    if (response.ok) {
      revalidatePath(`/people/${personId}/family-updates`);
      return { ok: true, data: data as T };
    }
    return feedProblem(error, conflict);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export interface FeedRequest {
  /** The form's UUIDv7, sent with every attempt so a retry never publishes twice. */
  readonly id: string;
  readonly source: PublishSource;
  readonly confirmationReason?: string;
}

function badRequest(personId: string, input: FeedRequest): ActionResult<never> | null {
  const sourceId =
    input.source.kind === "shared_note"
      ? input.source.noteId
      : input.source.kind === "activity"
        ? input.source.activityId
        : input.source.documentId;
  if (!isUuid(personId) || !isUuid(input.id) || !isUuid(sourceId)) {
    return refused(t("errors.notFound"), "not_found");
  }
  if (!FEED_SOURCE_KINDS.includes(input.source.kind)) return refused(t("care.errors.invalid"));
  const text =
    input.source.kind === "shared_note"
      ? input.source.text
      : input.source.kind === "photo"
        ? (input.source.caption ?? "")
        : "";
  if (text.length > FEED_TEXT_MAX || (input.confirmationReason?.length ?? 0) > CONFIRMATION_MAX) {
    return refused(t("care.errors.invalid"));
  }
  return null;
}

const body = (input: FeedRequest) => ({
  id: input.id,
  source: input.source,
  ...(input.confirmationReason?.trim()
    ? { confirmationReason: input.confirmationReason.trim() }
    : {}),
});

/** What publishing would make, or each problem with its code; nothing is stored (audited). */
export async function previewFeedItem(
  personId: string,
  input: FeedRequest,
): Promise<ActionResult<FeedPreview>> {
  const bad = badRequest(personId, input);
  if (bad) return bad;
  return send(personId, (api) =>
    api.POST("/v1/people/{id}/feed/preview", {
      params: { path: { id: personId } },
      body: body(input),
    }),
  );
}

/** Publish the update; the same id again returns the update already published. */
export async function publishFeedItem(
  personId: string,
  input: FeedRequest,
): Promise<ActionResult<{ id: string }>> {
  const bad = badRequest(personId, input);
  if (bad) return bad;
  const result = await send(personId, (api) =>
    api.POST("/v1/people/{id}/feed", { params: { path: { id: personId } }, body: body(input) }),
  );
  return result.ok ? { ok: true, data: { id: result.data.item.id } } : result;
}

/** Take an update down with a reason (`comms.feed.withdraw`); once only. */
export async function withdrawFeedItem(
  personId: string,
  itemId: string,
  reason: FeedWithdrawalReason,
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(itemId)) return refused(t("errors.notFound"), "not_found");
  if (!FEED_WITHDRAWAL_REASONS.includes(reason)) {
    return refused(t("comms.feed.withdraw.reasonError"), "invalid", ["reason"]);
  }
  return send(
    personId,
    (api) =>
      api.POST("/v1/feed-items/{id}/withdraw", {
        params: { path: { id: itemId } },
        body: { reason },
      }),
    t("comms.feed.withdraw.already"),
  );
}

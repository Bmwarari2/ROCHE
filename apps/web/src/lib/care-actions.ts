import "server-only";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "./api";
import { isUuid } from "./context-cookies";
import { t } from "./i18n";
import { type ActionResult, problemMessage, refused } from "./outcome";
import { isIsoInstant } from "./uk-time";

/**
 * Runs one write to a person's record through the API as the signed-in person. On success the
 * person's pages are revalidated, so the header (for example a new resuscitation decision) and
 * every tab show the change; on refusal the form gets words that say what to do next. The API
 * checks permission, scope and every rule again; the web app holds nothing of its own.
 */
export async function sendForPerson<T>(
  personId: string,
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  if (!isUuid(personId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate([`/people/${personId}`], call);
}

/**
 * Runs one write through the API as the signed-in person and, on success, revalidates the pages
 * under each path given (their layouts), so every page that shows the change reads it again. On
 * refusal the form gets words that say what to do next.
 */
export async function sendAndRevalidate<T>(
  paths: readonly string[],
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      for (const path of paths) revalidatePath(path, "layout");
      return { ok: true, data };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    // Redirects (the session ended, or step-up is needed) go through as navigation.
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** An append-only entry's id, when it happened and when the form was sent. */
export interface EntryTiming {
  /**
   * The entry's own UUIDv7, made by the form and sent with every attempt, so a retry after an
   * unknown outcome cannot record it twice (hazard HZ-029).
   */
  readonly id: string;
  /** When it happened, as an ISO instant ("now" is the moment the form was sent). */
  readonly occurredAt: string;
  /** The device's clock when the form was sent, so the API can flag clock drift (HZ-010). */
  readonly sentAt: string;
}

/**
 * The entry's time for the API, and the header that carries the device's clock reading
 * (`x-harbour-sent-at`, care.md rule 3), or a refusal saying what to enter.
 */
export function entryTime(
  timing: EntryTiming,
):
  | { readonly id: string; readonly occurredAt: string; readonly headers: Record<string, string> }
  | ActionResult<never> {
  if (!isUuid(timing.id)) return refused(t("care.errors.invalid"));
  if (!isIsoInstant(timing.occurredAt)) {
    return refused(t("care.errors.whenRequired"), "invalid", ["occurredAt"]);
  }
  return {
    id: timing.id,
    occurredAt: timing.occurredAt,
    headers: isIsoInstant(timing.sentAt) ? { "x-harbour-sent-at": timing.sentAt } : {},
  };
}

/** Whether a value from `entryTime` is a refusal rather than a time. */
export function isRefusal(value: unknown): value is ActionResult<never> {
  return typeof value === "object" && value !== null && "ok" in value;
}

/** Trimmed text, or undefined when empty, for optional API fields. */
export function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

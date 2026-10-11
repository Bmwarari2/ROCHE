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
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath(`/people/${personId}`, "layout");
      return { ok: true, data };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    // Redirects (the session ended, or step-up is needed) go through as navigation.
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** When an entry happened and when the form was sent, both from the form (lib/uk-time.ts). */
export interface EntryTiming {
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
): { readonly occurredAt: string; readonly headers: Record<string, string> } | ActionResult<never> {
  if (!isIsoInstant(timing.occurredAt)) return refused(t("care.errors.whenRequired"));
  return {
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

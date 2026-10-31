"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { contentOrigin, ELEARNING_PAGE, launchUrl } from "@/lib/elearning";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * E-learning writes (ADR-0093): start or resume one's own attempt (the API signs the launch
 * token), save what the runtime committed (the player has already checked the message's origin,
 * frame, shape and attempt; the API checks the allowlist again), and retire a course.
 */

async function withApi<T>(fn: (api: ApiClient) => Promise<ActionResult<T>>) {
  try {
    return await fn(await tenantApi());
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");

export interface Launched {
  readonly attemptId: string;
  readonly url: string;
  readonly contentOrigin: string;
  readonly start: {
    readonly standard: "scorm_1_2" | "scorm_2004" | "xapi";
    readonly launchPath: string;
    readonly launchQuery: string;
    readonly location: string | null;
    readonly suspendData: string | null;
    readonly entry: "ab-initio" | "resume";
    readonly learnerId: string;
    readonly learnerName: string;
  };
}

export async function startAttempt(courseId: string): Promise<ActionResult<Launched>> {
  if (!isUuid(courseId)) return notFound();
  const origin = contentOrigin();
  if (!origin) return refused(t("elearning.player.notConfigured"), "not_configured");
  return withApi<Launched>(async (api) => {
    const { me } = await getShellContext();
    const { data, error } = await api.POST("/v1/workforce/elearning/courses/{id}/attempts", {
      params: { path: { id: courseId } },
    });
    if (!data) return { ok: false, ...problemMessage(error, t) };
    return {
      ok: true,
      data: {
        attemptId: data.attemptId,
        url: launchUrl(origin, data.token),
        contentOrigin: origin,
        start: {
          standard: data.standard,
          launchPath: data.launchPath,
          launchQuery: data.launchQuery,
          location: data.location,
          suspendData: data.suspendData,
          entry: data.entry,
          learnerId: me.tenantUserId,
          learnerName: me.user.name,
        },
      },
    };
  });
}

export async function commitAttempt(
  attemptId: string,
  input: { readonly cmi: Record<string, string>; readonly finished: boolean },
): Promise<ActionResult<{ status: string }>> {
  if (!isUuid(attemptId) || typeof input !== "object" || input === null) return notFound();
  if (typeof input.finished !== "boolean" || typeof input.cmi !== "object" || input.cmi === null) {
    return notFound();
  }
  const entries = Object.entries(input.cmi);
  if (entries.length > 50 || entries.some(([k, v]) => typeof v !== "string" || k.length > 200)) {
    return notFound();
  }
  return withApi(async (api) => {
    const { data, error } = await api.PATCH("/v1/workforce/elearning/attempts/{id}", {
      params: { path: { id: attemptId } },
      body: { cmi: Object.fromEntries(entries), finished: input.finished },
    });
    if (!data) return { ok: false, ...problemMessage(error, t) };
    if (data.status !== "in_progress") revalidatePath(ELEARNING_PAGE);
    return { ok: true, data: { status: data.status } };
  });
}

export async function retireCourse(courseId: string): Promise<ActionResult<null>> {
  if (!isUuid(courseId)) return notFound();
  return withApi<null>(async (api) => {
    const { data, error } = await api.POST("/v1/workforce/elearning/courses/{id}/retire", {
      params: { path: { id: courseId } },
    });
    if (!data) return { ok: false, ...problemMessage(error, t) };
    revalidatePath(ELEARNING_PAGE);
    return { ok: true, data: null };
  });
}

import "server-only";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "./api";
import { t } from "./i18n";
import { type ActionResult, problemMessage } from "./outcome";

/**
 * Runs one quality write (an evidence pack or the statement of purpose) through the API as the
 * signed-in person, and revalidates the screens that show it. The API's refusals are said in
 * words a manager can act on: separation of duties in this module's terms, and a workflow or
 * changed-record refusal (409) in the API's own plain words, which name what to do.
 */
export async function sendQuality<T>(
  subject: "pack" | "sop" | "policy" | "dataSecurity",
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
    return { ok: false, ...qualityProblem(subject, error) };
  } catch (error) {
    // Redirects (the session ended, or step-up is needed) go through as navigation.
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

function qualityProblem(subject: "pack" | "sop" | "policy" | "dataSecurity", error: unknown) {
  const problem = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    detail?: unknown;
    title?: unknown;
  };
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  switch (problem.code) {
    case "separation_of_duties":
      return { code: "separation_of_duties", message: t("quality.separation", { subject }) };
    case "invalid_state":
    case "record_changed":
      return { code: problem.code, message: detail || t("quality.changed", { subject }) };
    case "version_conflict":
      return { code: "version_conflict", message: t("quality.changed", { subject }) };
    default: {
      // A refusal this module names in its own words (evidence_required, notes_required and the
      // like) is said as the API says it, never as "could not save just now".
      const fallback = problemMessage(error, t);
      const code = typeof problem.code === "string" ? problem.code : "";
      const words = detail || (typeof problem.title === "string" ? problem.title.trim() : "");
      const ownWords = /^[a-z_]+$/.test(code) && code !== "internal" && code !== "unavailable";
      return fallback.code === "unavailable" && words && ownWords
        ? { code, message: words }
        : fallback;
    }
  }
}

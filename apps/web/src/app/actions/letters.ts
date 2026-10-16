"use server";

import type { LetterTemplateItem } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  REASON_MAX,
  REASON_MIN,
  TEMPLATE_CHANNELS,
  TEMPLATE_KINDS,
  type TemplateChannel,
  type TemplateKind,
} from "@/lib/letters";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Letter and email template writes (comms.md rules 18 to 23; COMMS-007; HZ-051), sent to the API
 * as the signed-in person. The API checks the permission, the version loaded and every rule, and
 * a draft is saved with its problems listed; the web holds nothing of its own. Every write but a
 * new template names the version it was made against, so a second attempt is refused as stale,
 * never applied twice.
 */

/** A refusal in words: approval by the author or an editor, and a version that moved on. */
function templateProblem(error: unknown): ActionResult<never> {
  const problem = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    detail?: unknown;
  };
  const detail = typeof problem.detail === "string" ? problem.detail : "";
  switch (problem.code) {
    case "separation_of_duties":
      return refused(t("comms.templates.refusal.ownDraft"), "separation_of_duties");
    case "invalid_state":
      return refused(detail || t("comms.templates.refusal.state"), "invalid_state");
    default:
      return { ok: false, ...problemMessage(error, t) };
  }
}

async function send<T>(
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath("/letters", "layout");
      return { ok: true, data };
    }
    return templateProblem(error);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export interface DraftWords {
  readonly name: string;
  readonly subject: string | null;
  readonly body: string;
}

interface VersionRef {
  readonly templateId: string;
  readonly versionId: string;
  readonly version: number;
}

const badRef = (ref: VersionRef) => !isUuid(ref.templateId) || !isUuid(ref.versionId);

/** A new template with its first draft (`comms.template.write`). */
export async function createTemplate(
  input: DraftWords & { readonly kind: TemplateKind; readonly channel: TemplateChannel },
): Promise<ActionResult<LetterTemplateItem>> {
  if (!TEMPLATE_KINDS.includes(input.kind) || !TEMPLATE_CHANNELS.includes(input.channel)) {
    return refused(t("care.errors.invalid"));
  }
  return send((api) => api.POST("/v1/letter-templates", { body: { ...input } }));
}

/** Change a draft; the editor joins its contributors and so cannot approve it. */
export async function editDraft(
  ref: VersionRef,
  words: DraftWords,
): Promise<ActionResult<unknown>> {
  if (badRef(ref)) return refused(t("errors.notFound"), "not_found");
  return send((api) =>
    api.PUT("/v1/letter-templates/{id}/versions/{versionId}", {
      params: { path: { id: ref.templateId, versionId: ref.versionId } },
      body: { ...words, version: ref.version },
    }),
  );
}

/** A new draft from the version in use, which stays in use until the draft is approved. */
export async function startDraft(templateId: string): Promise<ActionResult<unknown>> {
  if (!isUuid(templateId)) return refused(t("errors.notFound"), "not_found");
  return send((api) =>
    api.POST("/v1/letter-templates/{id}/versions", { params: { path: { id: templateId } } }),
  );
}

/** Approve a draft (`comms.template.approve`, never its author or an editor). */
export async function approveVersion(ref: VersionRef): Promise<ActionResult<unknown>> {
  if (badRef(ref)) return refused(t("errors.notFound"), "not_found");
  return send((api) =>
    api.POST("/v1/letter-templates/{id}/versions/{versionId}/approve", {
      params: { path: { id: ref.templateId, versionId: ref.versionId } },
      body: { version: ref.version },
    }),
  );
}

/** Retire the version in use, or discard a draft, with a reason. */
export async function endVersion(
  how: "retire" | "discard",
  ref: VersionRef,
  reason: string,
): Promise<ActionResult<unknown>> {
  if (badRef(ref)) return refused(t("errors.notFound"), "not_found");
  const words = reason.trim();
  if (words.length < REASON_MIN || words.length > REASON_MAX) {
    return refused(
      t("comms.templates.reasonError", { how, min: REASON_MIN, max: REASON_MAX }),
      "invalid",
      ["reason"],
    );
  }
  const path =
    how === "retire"
      ? ("/v1/letter-templates/{id}/versions/{versionId}/retire" as const)
      : ("/v1/letter-templates/{id}/versions/{versionId}/discard" as const);
  return send((api) =>
    api.POST(path, {
      params: { path: { id: ref.templateId, versionId: ref.versionId } },
      body: { reason: words, version: ref.version },
    }),
  );
}

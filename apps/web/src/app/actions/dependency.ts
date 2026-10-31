"use server";

import type { DependencyScaleDefinition } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { DEPENDENCY_PAGE } from "@/lib/dependency";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * The dependency tool's writes (scheduling.md section 12; CARE-004; HZ-123): the organisation's
 * own scales and their versions (a draft approved by someone who did not write or change it), and
 * a person's category. The API checks the permissions, the scope and every rule again.
 */

async function send<T>(
  ids: readonly string[],
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
  paths: readonly string[] = [DEPENDENCY_PAGE],
): Promise<ActionResult<T>> {
  if (!ids.every((id) => isUuid(id))) return refused(t("errors.notFound"), "not_found");
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok || data === undefined) return { ok: false, ...problemMessage(error, t) };
    for (const p of paths) revalidatePath(p, "layout");
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export async function createScale(
  name: string,
  locationId: string | null,
  definition: DependencyScaleDefinition,
): Promise<ActionResult<{ id: string }>> {
  return send(locationId ? [locationId] : [], (api) =>
    api.POST("/v1/dependency-scales", { body: { name, locationId, definition } }),
  );
}

export async function startDraft(scaleId: string): Promise<ActionResult<unknown>> {
  return send([scaleId], (api) =>
    api.POST("/v1/dependency-scales/{id}/versions", { params: { path: { id: scaleId } } }),
  );
}

export async function saveDraft(
  scaleId: string,
  versionId: string,
  version: number,
  definition: DependencyScaleDefinition,
): Promise<ActionResult<unknown>> {
  return send([scaleId, versionId], (api) =>
    api.PUT("/v1/dependency-scales/{id}/versions/{versionId}", {
      params: { path: { id: scaleId, versionId } },
      body: { definition, version },
    }),
  );
}

export async function approveDraft(
  scaleId: string,
  versionId: string,
  version: number,
): Promise<ActionResult<unknown>> {
  return send([scaleId, versionId], (api) =>
    api.POST("/v1/dependency-scales/{id}/versions/{versionId}/approve", {
      params: { path: { id: scaleId, versionId } },
      body: { version },
    }),
  );
}

export async function discardDraft(
  scaleId: string,
  versionId: string,
  version: number,
  reason: string,
): Promise<ActionResult<unknown>> {
  return send([scaleId, versionId], (api) =>
    api.POST("/v1/dependency-scales/{id}/versions/{versionId}/discard", {
      params: { path: { id: scaleId, versionId } },
      body: { version, reason },
    }),
  );
}

export async function archiveScale(
  scaleId: string,
  version: number,
  reason: string,
): Promise<ActionResult<unknown>> {
  return send([scaleId], (api) =>
    api.POST("/v1/dependency-scales/{id}/archive", {
      params: { path: { id: scaleId } },
      body: { version, reason },
    }),
  );
}

/** Records a person's category from the approved version at their home, with why and who decided. */
export async function recordDependency(
  personId: string,
  body: {
    readonly id: string;
    readonly kind: "initial" | "review" | "correction";
    readonly categoryKey: string;
    readonly effectiveFrom: string;
    readonly reason: string;
    readonly decidedBy: string;
    readonly supersedesId: string | null;
  },
): Promise<ActionResult<unknown>> {
  const ids = [
    personId,
    body.id,
    body.decidedBy,
    ...(body.supersedesId ? [body.supersedesId] : []),
  ];
  return send(
    ids,
    (api) =>
      api.POST("/v1/people/{id}/dependency", {
        params: { path: { id: personId } },
        body: { ...body, oneToOne: [] },
      }),
    [`/people/${personId}`],
  );
}

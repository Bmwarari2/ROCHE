"use server";

import type { DeclareOutage, OutageItem } from "@harbour/contracts";
import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { OUTAGE_KINDS } from "@/lib/downtime";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import { isIsoInstant } from "@/lib/uk-time";

/**
 * Outage writes (operations.md section 13, part 3c; HZ-017), sent to the API as the signed-in
 * person. The API checks the permission where the location is, the outage's version and every
 * rule again, and refuses in its own words; the web app holds nothing of its own. Outages are
 * mutable aggregates checked by version, so a write sent twice is refused as stale, never applied
 * twice.
 */

type Outcome = ActionResult<OutageItem>;

/** The API's refusal in words: an overlap found at the same moment is said as the API says it. */
function outageProblem(error: unknown): Outcome {
  const problem = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    detail?: unknown;
    title?: unknown;
  };
  if (problem.code === "outage_overlap") {
    const words = typeof problem.detail === "string" ? problem.detail : problem.title;
    return refused(typeof words === "string" ? words : t("care.errors.invalid"), "invalid");
  }
  return { ok: false, ...problemMessage(error, t) };
}

async function send(
  locationId: string,
  call: (api: ApiClient) => Promise<{ data?: OutageItem; error?: unknown }>,
): Promise<Outcome> {
  if (!isUuid(locationId)) return refused(t("errors.notFound"), "not_found");
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath(`/downtime/${locationId}`, "layout");
      return { ok: true, data };
    }
    return outageProblem(error);
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const words = (value: string, max: number) => {
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
};

export async function declareOutage(locationId: string, input: DeclareOutage): Promise<Outcome> {
  if (!OUTAGE_KINDS.includes(input.kind)) {
    return refused(t("operations.outage.form.kindRequired"), "invalid", ["kind"]);
  }
  const description = words(input.description, 1000);
  if (!description) {
    return refused(t("operations.outage.form.descriptionRequired"), "invalid", ["description"]);
  }
  if (!isIsoInstant(input.startedAt)) {
    return refused(t("operations.outage.form.startRequired"), "invalid", ["startedAt"]);
  }
  if (input.endedAt !== undefined && !isIsoInstant(input.endedAt)) {
    return refused(t("care.errors.invalid"), "invalid", ["endedAt"]);
  }
  return send(locationId, (api) =>
    api.POST("/v1/locations/{id}/outages", {
      params: { path: { id: locationId } },
      body: {
        kind: input.kind,
        description,
        startedAt: input.startedAt,
        ...(input.endedAt ? { endedAt: input.endedAt } : {}),
      },
    }),
  );
}

export async function closeOutage(
  locationId: string,
  outageId: string,
  input: { readonly endedAt: string; readonly version: number },
): Promise<Outcome> {
  if (!isUuid(outageId)) return refused(t("errors.notFound"), "not_found");
  if (!isIsoInstant(input.endedAt)) {
    return refused(t("operations.outage.form.endRequired"), "invalid", ["endedAt"]);
  }
  return send(locationId, (api) =>
    api.POST("/v1/outages/{id}/close", {
      params: { path: { id: outageId } },
      body: { endedAt: input.endedAt, version: input.version },
    }),
  );
}

export async function cancelOutage(
  locationId: string,
  outageId: string,
  input: { readonly reason: string; readonly version: number },
): Promise<Outcome> {
  if (!isUuid(outageId)) return refused(t("errors.notFound"), "not_found");
  const reason = words(input.reason, 1000);
  if (!reason) return refused(t("operations.outage.cancel.reasonRequired"), "invalid", ["reason"]);
  return send(locationId, (api) =>
    api.POST("/v1/outages/{id}/cancel", {
      params: { path: { id: outageId } },
      body: { reason, version: input.version },
    }),
  );
}

export async function correctOutage(
  locationId: string,
  outageId: string,
  input: {
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly reason: string;
    readonly version: number;
  },
): Promise<Outcome> {
  if (!isUuid(outageId)) return refused(t("errors.notFound"), "not_found");
  if (!isIsoInstant(input.startedAt)) {
    return refused(t("operations.outage.form.startRequired"), "invalid", ["startedAt"]);
  }
  if (input.endedAt !== null && !isIsoInstant(input.endedAt)) {
    return refused(t("operations.outage.form.endRequired"), "invalid", ["endedAt"]);
  }
  const reason = words(input.reason, 500);
  if (!reason) {
    return refused(t("operations.outage.correct.reasonRequired"), "invalid", ["reason"]);
  }
  return send(locationId, (api) =>
    api.POST("/v1/outages/{id}/correct", {
      params: { path: { id: outageId } },
      body: {
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        reason,
        version: input.version,
      },
    }),
  );
}

export async function reconcileOutage(
  locationId: string,
  outageId: string,
  input: {
    readonly statement: string;
    readonly reviewedEntryIds: readonly string[];
    readonly version: number;
  },
): Promise<Outcome> {
  if (!isUuid(outageId)) return refused(t("errors.notFound"), "not_found");
  const statement = words(input.statement, 2000);
  if (!statement) {
    return refused(t("operations.reconcile.statementRequired"), "invalid", ["statement"]);
  }
  if (input.reviewedEntryIds.length > 1000 || !input.reviewedEntryIds.every(isUuid)) {
    return refused(t("care.errors.invalid"), "invalid");
  }
  return send(locationId, (api) =>
    api.POST("/v1/outages/{id}/reconcile", {
      params: { path: { id: outageId } },
      body: { statement, reviewedEntryIds: [...input.reviewedEntryIds], version: input.version },
    }),
  );
}

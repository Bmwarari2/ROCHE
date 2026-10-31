"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { REQUESTS_PAGE } from "@/lib/data-rights";
import { dsarProblem, requestPage } from "@/lib/dsar";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * The DSAR workbench's writes (PLAT-022; platform.md, the DSAR workbench), each as the signed-in
 * person. The API checks the organisation-wide permission, MFA, step-up (deciding a record it
 * opened, responding) and every rule again; the web app keeps nothing.
 */

type Call<T> = (
  api: ApiClient,
) => Promise<{ readonly data?: T; readonly error?: unknown; readonly response: Response }>;

async function send<T>(caseId: string | null, call: Call<T>): Promise<ActionResult<T>> {
  if (caseId !== null && !isUuid(caseId)) return refused(t("errors.notFound"), "not_found");
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok || data === undefined) return { ok: false, ...dsarProblem(error, t) };
    revalidatePath(REQUESTS_PAGE);
    if (caseId) revalidatePath(requestPage(caseId));
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...dsarProblem(undefined, t) };
  }
}

export interface NewRequestInput {
  readonly requestKind: "access" | "rectification" | "erasure" | "portability";
  readonly subjectKind: "person" | "staff";
  readonly subjectId: string;
  readonly requesterKind: "subject" | "representative";
  readonly requesterName: string | null;
  readonly requesterAddress: string | null;
  readonly authority:
    | "lpa_health_welfare"
    | "lpa_property_finance"
    | "deputy"
    | "written_authority"
    | "other"
    | null;
  readonly channel: "email" | "post" | "phone" | "in_person" | "portal";
  readonly receivedOn: string;
  readonly identityRequired: boolean;
}

/** Records a new request; the result carries its id, to open it. */
export async function recordRequest(
  input: NewRequestInput,
): Promise<ActionResult<{ readonly id: string }>> {
  if (!isUuid(input.subjectId)) {
    return refused(t("dataRights.new.chooseSubject"), "invalid", ["subject"]);
  }
  const { subjectKind, subjectId, ...rest } = input;
  return send(null, (api) =>
    api.POST("/v1/dsar-cases", {
      body: {
        ...rest,
        subjectKind,
        subjectPersonId: subjectKind === "person" ? subjectId : null,
        subjectContactId: null,
        subjectStaffId: subjectKind === "staff" ? subjectId : null,
      },
    }),
  );
}

const path = (id: string) => ({ params: { path: { id } } });

export async function confirmIdentity(
  id: string,
  body: {
    readonly verifiedOn: string;
    readonly method: "document_seen" | "known_to_staff" | "authority_checked" | "portal_account";
    readonly expectedVersion: number;
  },
): Promise<ActionResult<unknown>> {
  return send(id, (api) => api.POST("/v1/dsar-cases/{id}/identity", { ...path(id), body }));
}

export async function startPause(
  id: string,
  body: { readonly from: string; readonly expectedVersion: number },
): Promise<ActionResult<unknown>> {
  return send(id, (api) => api.POST("/v1/dsar-cases/{id}/pauses", { ...path(id), body }));
}

export async function endPause(
  id: string,
  body: { readonly to: string; readonly expectedVersion: number },
): Promise<ActionResult<unknown>> {
  return send(id, (api) => api.POST("/v1/dsar-cases/{id}/pauses/end", { ...path(id), body }));
}

export async function extendDeadline(
  id: string,
  body: {
    readonly months: number;
    readonly grounds: "complex" | "multiple_requests";
    readonly reason: string;
    readonly decidedOn: string;
    readonly expectedVersion: number;
  },
): Promise<ActionResult<unknown>> {
  return send(id, (api) => api.POST("/v1/dsar-cases/{id}/extension", { ...path(id), body }));
}

/** Finds the subject's records across every module; the result says what was found and missed. */
export async function collectRecords(id: string) {
  return send(id, (api) => api.POST("/v1/dsar-cases/{id}/collect", path(id)));
}

export async function decideRecord(
  id: string,
  itemId: string,
  body: {
    readonly decision: "disclose" | "redact" | "withhold";
    readonly redactedFields: readonly string[];
    readonly reason: string | null;
    readonly contentSha256: string;
    readonly expectedVersion: number;
  },
): Promise<ActionResult<unknown>> {
  if (!isUuid(itemId)) return refused(t("errors.notFound"), "not_found");
  return send(id, (api) =>
    api.POST("/v1/dsar-cases/{id}/items/{itemId}/decision", {
      params: { path: { id, itemId } },
      body: { ...body, redactedFields: [...body.redactedFields] },
    }),
  );
}

export async function recordResponse(
  id: string,
  body: {
    readonly respondedOn: string;
    readonly outcome: "fulfilled" | "partly_fulfilled" | "refused" | "withdrawn";
    readonly outcomeReason: string | null;
    readonly expectedVersion: number;
  },
): Promise<ActionResult<unknown>> {
  return send(id, (api) => api.POST("/v1/dsar-cases/{id}/respond", { ...path(id), body }));
}

/** Checks each collected record against retention and records the result; deletes nothing. */
export async function assessErasure(
  id: string,
  expectedVersion: number,
): Promise<ActionResult<unknown>> {
  return send(id, (api) =>
    api.POST("/v1/dsar-cases/{id}/erasure", { ...path(id), body: { expectedVersion } }),
  );
}

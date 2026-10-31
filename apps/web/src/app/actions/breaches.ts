"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { type BreachFactors, breachPath } from "@/lib/breaches";
import { isUuid } from "@/lib/context-cookies";
import { dataProtectionProblem } from "@/lib/data-protection-refusals";
import { BREACHES_PAGE } from "@/lib/data-rights";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";

/**
 * The breach register's writes (PLAT-022; platform.md rules 18 to 24), each as the signed-in
 * person. The API checks the permission across the organisation, the version and every rule
 * again; the web app keeps nothing.
 */

type Sent<T> = { readonly ok: boolean; readonly error?: unknown; readonly data?: T };

async function send<T>(
  id: string | null,
  call: (api: ApiClient) => Promise<Sent<T>>,
): Promise<ActionResult<T | null>> {
  if (id !== null && !isUuid(id)) return refused(t("errors.notFound"), "not_found");
  try {
    const { ok, error, data } = await call(await tenantApi());
    if (!ok) return { ok: false, ...dataProtectionProblem(error, t) };
    revalidatePath(BREACHES_PAGE);
    if (id) revalidatePath(breachPath(id));
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...dataProtectionProblem(undefined, t) };
  }
}

export interface RecordBreachInput {
  readonly summary: string;
  readonly awareAt: string;
  readonly occurredAt: string | null;
}

/** Records a breach in the register; the ICO clock starts from when the organisation became aware. */
export async function recordBreach(
  input: RecordBreachInput,
): Promise<ActionResult<{ readonly id: string } | null>> {
  return send(null, async (api) => {
    const { response, error, data } = await api.POST("/v1/data-protection/breaches", {
      body: input,
    });
    return { ok: response.ok, error, ...(data ? { data: { id: data.id } } : {}) };
  });
}

/** Records the assessment factors; the API stores Harbour's suggestion beside them. */
export async function assessBreach(
  id: string,
  expectedVersion: number,
  factors: BreachFactors,
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } = await api.POST("/v1/data-protection/breaches/{id}/assessment", {
      params: { path: { id } },
      body: { expectedVersion, factors },
    });
    return { ok: response.ok, error };
  });
}

export interface DecideBreachInput {
  readonly expectedVersion: number;
  readonly reportToIco: boolean;
  readonly tellIndividuals: boolean;
  readonly reasoning: string;
  readonly acknowledgedSuggestion: boolean;
}

/** Records the person's decision with their reasoning. */
export async function decideBreach(
  id: string,
  input: DecideBreachInput,
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } = await api.POST("/v1/data-protection/breaches/{id}/decision", {
      params: { path: { id } },
      body: input,
    });
    return { ok: response.ok, error };
  });
}

export interface ReportBreachInput {
  readonly expectedVersion: number;
  readonly reportedAt: string;
  readonly icoReference: string;
  readonly delayReason: string | null;
}

/** Records the report to the ICO, with the reasons for any delay. */
export async function reportBreach(
  id: string,
  input: ReportBreachInput,
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } = await api.POST("/v1/data-protection/breaches/{id}/ico-report", {
      params: { path: { id } },
      body: input,
    });
    return { ok: response.ok, error };
  });
}

/** Records the notice sent to the people affected and the day they were told. */
export async function tellIndividuals(
  id: string,
  input: { readonly expectedVersion: number; readonly notice: string; readonly toldOn: string },
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } = await api.POST(
      "/v1/data-protection/breaches/{id}/individuals-told",
      { params: { path: { id } }, body: input },
    );
    return { ok: response.ok, error };
  });
}

/** Closes the entry with its lessons; once closed nothing changes. */
export async function closeBreach(
  id: string,
  input: { readonly expectedVersion: number; readonly lessons: string },
): Promise<ActionResult<null>> {
  return send(id, async (api) => {
    const { response, error } = await api.POST("/v1/data-protection/breaches/{id}/close", {
      params: { path: { id } },
      body: input,
    });
    return { ok: response.ok, error };
  });
}

/** Acknowledges a notice from Thapsus about this breach, in the signed-in person's name. */
export async function acknowledgeNotice(
  breachId: string,
  noticeId: string,
): Promise<ActionResult<null>> {
  if (!isUuid(noticeId)) return refused(t("errors.notFound"), "not_found");
  return send(breachId, async (api) => {
    const { response, error } = await api.POST(
      "/v1/data-protection/breach-notices/{id}/acknowledge",
      { params: { path: { id: noticeId } } },
    );
    return { ok: response.ok, error };
  });
}

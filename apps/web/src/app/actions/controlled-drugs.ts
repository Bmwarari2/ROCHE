"use server";

import type { components } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { CD_FIELD_FOR_PROBLEM, cdPageHref, cdTabHref } from "@/lib/controlled-drugs";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Controlled drugs register writes (MEDS-005; medicines.md section 15). The API needs the
 * permission, a fresh step-up and (for a witness) current medicines competence, runs every
 * register rule and keeps the running balance; its refusals are shown in its own words. The web
 * keeps nothing.
 */

type Schemas = components["schemas"];
type Api = Awaited<ReturnType<typeof tenantApi>>;

/** A register refusal in the API's words, at its field where it has one; others as usual. */
function cdProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  if (!detail || !code.startsWith("cd_")) return problemMessage(error, t);
  const field = CD_FIELD_FOR_PROBLEM[code];
  return field ? { code, message: detail, fields: { [field]: detail } } : { code, message: detail };
}

async function send<T>(
  personId: string,
  pageId: string | null,
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...cdProblem(error) };
    revalidatePath(cdTabHref(personId));
    if (pageId) revalidatePath(cdPageHref(personId, pageId));
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");
const ids = (...values: string[]) => values.every(isUuid);

/** Opens (or finds) the register page for a medicine on the MAR. */
export async function openCdPage(
  personId: string,
  entryId: string,
): Promise<ActionResult<{ readonly id: string } | null>> {
  if (!ids(personId, entryId)) return notFound();
  return send(personId, null, (api) =>
    api.POST("/v1/people/{id}/controlled-drugs/pages", {
      params: { path: { id: personId } },
      body: { entryId },
    }),
  );
}

/** The witness signs, in their own session, for what they saw (ADR-0084 on the web). */
export async function signAsWitness(
  personId: string,
  pageId: string,
  body: Schemas["AssertWitness"],
): Promise<ActionResult<Schemas["WitnessAssertion"] | null>> {
  if (!ids(personId, pageId, body.recorderId)) return notFound();
  return send(personId, pageId, (api) =>
    api.POST("/v1/controlled-drugs/pages/{pageId}/witness-assertions", {
      params: { path: { pageId } },
      body,
    }),
  );
}

/** A receipt, return, disposal, destruction or correction, naming the witness's signature. */
export async function recordCdEntry(
  personId: string,
  pageId: string,
  body: Schemas["RecordCdEntry"],
): Promise<ActionResult<unknown>> {
  if (!ids(personId, pageId)) return notFound();
  return send(personId, pageId, (api) =>
    api.POST("/v1/controlled-drugs/pages/{pageId}/entries", { params: { path: { pageId } }, body }),
  );
}

/** A count against the page. */
export async function recordStockCheck(
  personId: string,
  pageId: string,
  body: Schemas["RecordStockCheck"],
): Promise<ActionResult<Schemas["StockCheckRecorded"] | null>> {
  if (!ids(personId, pageId)) return notFound();
  return send(personId, pageId, (api) =>
    api.POST("/v1/controlled-drugs/pages/{pageId}/stock-checks", {
      params: { path: { pageId } },
      body,
    }),
  );
}

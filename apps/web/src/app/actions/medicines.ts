"use server";

import type { components } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  type DraftInput,
  medicinesHref,
  type ProductHit,
  REASON_FOR_PROBLEM,
  type ReconciliationLine,
  type TranscribeBody,
} from "@/lib/medicines";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * The medicines record writes (MEDS-001, MEDS-006; medicines.md section 13). The API runs every
 * medicines rule, reads competence from the workforce port and dm+d's facts for the product, and
 * answers a refusal with every problem in words: those words are shown as they are, at the field a
 * reason belongs to where the API asks for one. The web keeps nothing.
 */

type Schemas = components["schemas"];
type Api = Awaited<ReturnType<typeof tenantApi>>;

/** A medicines refusal in the API's own words; anything else as usual. */
function medicinesProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  if (!detail || !(code.startsWith("medicine_") || code.startsWith("dmd_"))) {
    return problemMessage(error, t);
  }
  const field = REASON_FOR_PROBLEM[code];
  return field ? { code, message: detail, fields: { [field]: detail } } : { code, message: detail };
}

async function send<T>(
  personId: string,
  call: (api: Api) => Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<ActionResult<T | null>> {
  try {
    const { data, error, response } = await call(await tenantApi());
    if (!response.ok) return { ok: false, ...medicinesProblem(error) };
    revalidatePath(medicinesHref(personId), "layout");
    return { ok: true, data: data ?? null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const notFound = () => refused(t("errors.notFound"), "not_found");

/** dm+d products whose name holds every word typed (two or more characters). */
export async function searchProducts(
  query: string,
): Promise<ActionResult<{ loaded: boolean; items: ProductHit[] } | null>> {
  const q = query.trim();
  if (q.length < 2 || q.length > 100) return refused(t("medicines.search.tooShort"), "invalid");
  try {
    const api = await tenantApi();
    const { data, error, response } = await api.GET("/v1/medicines/products", {
      params: { query: { q } },
    });
    if (!response.ok || !data) return { ok: false, ...problemMessage(error, t) };
    return { ok: true, data };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

export async function transcribeMedicine(
  personId: string,
  body: TranscribeBody,
): Promise<ActionResult<Schemas["MedicineEntry"] | null>> {
  if (!isUuid(personId)) return notFound();
  return send(personId, (api) =>
    api.POST("/v1/people/{id}/medicines", { params: { path: { id: personId } }, body }),
  );
}

export async function checkMedicine(
  personId: string,
  entryId: string,
  body: Schemas["CheckMedicine"],
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(entryId)) return notFound();
  return send(personId, (api) =>
    api.POST("/v1/medicines/{entryId}/check", { params: { path: { entryId } }, body }),
  );
}

export async function stopMedicine(
  personId: string,
  entryId: string,
  body: Schemas["StopMedicine"],
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(entryId)) return notFound();
  return send(personId, (api) =>
    api.POST("/v1/medicines/{entryId}/stop", { params: { path: { entryId } }, body }),
  );
}

export async function startReconciliation(
  personId: string,
  body: Schemas["StartReconciliation"],
): Promise<ActionResult<{ readonly id: string } | null>> {
  if (!isUuid(personId) || (body.eventId !== null && !isUuid(body.eventId ?? ""))) {
    return notFound();
  }
  return send(personId, (api) =>
    api.POST("/v1/people/{id}/medicine-reconciliations", {
      params: { path: { id: personId } },
      body,
    }),
  );
}

export async function addReconciliationSource(
  personId: string,
  recId: string,
  body: Schemas["AddReconciliationSource"],
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(recId)) return notFound();
  return send(personId, (api) =>
    api.POST("/v1/people/{id}/medicine-reconciliations/{recId}/sources", {
      params: { path: { id: personId, recId } },
      body,
    }),
  );
}

export async function addReconciliationItem(
  personId: string,
  recId: string,
  body: ReconciliationLine,
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(recId) || !isUuid(body.sourceId)) return notFound();
  return send(personId, (api) =>
    api.POST("/v1/people/{id}/medicine-reconciliations/{recId}/items", {
      params: { path: { id: personId, recId } },
      // why: the generated type cannot hold a product (see ReconciliationLine); the API's own
      // schema validates it.
      body: body as unknown as Schemas["AddReconciliationItem"],
    }),
  );
}

export type OneDecision =
  | { readonly on: "entry"; readonly decision: Schemas["EntryDecision"] }
  | { readonly on: "item"; readonly decision: Schemas["ItemDecision"] };

/**
 * One person's decision about one entry or line. The API takes every decision at once and replaces
 * the earlier set, so this reads the reconciliation, refuses if it has moved on from the version on
 * the person's screen, and replaces only the decision for that entry or line at that version (the
 * API refuses a stale one too). The API records the saver as the decider of the whole set (H-1286).
 */
export async function decideReconciliation(
  personId: string,
  recId: string,
  /** The version on the person's screen: anything decided since by someone else refuses this. */
  seenVersion: number,
  one: OneDecision,
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(recId) || !Number.isInteger(seenVersion)) return notFound();
  return send(personId, async (api) => {
    const current = await api.GET("/v1/people/{id}/medicine-reconciliations/{recId}", {
      params: { path: { id: personId, recId } },
    });
    if (!current.data) return current;
    const rec = current.data;
    if (rec.version !== seenVersion) {
      // Never overwrite a decision the person has not seen (clinical review of slice 52, H1).
      return {
        error: { code: "version_conflict" },
        response: new Response(null, { status: 409 }),
      };
    }
    const entryDecisions =
      one.on === "entry"
        ? [...rec.entryDecisions.filter((d) => d.entryId !== one.decision.entryId), one.decision]
        : rec.entryDecisions;
    const itemDecisions =
      one.on === "item"
        ? [...rec.itemDecisions.filter((d) => d.itemId !== one.decision.itemId), one.decision]
        : rec.itemDecisions;
    return api.PUT("/v1/people/{id}/medicine-reconciliations/{recId}/decisions", {
      params: { path: { id: personId, recId } },
      body: { expectedVersion: seenVersion, entryDecisions, itemDecisions },
    });
  });
}

export async function completeReconciliation(
  personId: string,
  recId: string,
  body: Schemas["CompleteReconciliation"],
): Promise<ActionResult<unknown>> {
  if (!isUuid(personId) || !isUuid(recId)) return notFound();
  return send(personId, (api) =>
    api.POST("/v1/people/{id}/medicine-reconciliations/{recId}/complete", {
      params: { path: { id: personId, recId } },
      body,
    }),
  );
}

export type { DraftInput };

"use server";

import { CorrectAdministration, ResolveConflict } from "@harbour/contracts";
import type { components } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { administrationsHref } from "@/lib/administration-corrections";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { ADMINISTRATION_FIELD_FOR_PROBLEM, personRoundHref } from "@/lib/medicine-round";
import { medicinesHref } from "@/lib/medicines";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Deciding a dose recorded twice and correcting an administration record (HZ-004; medicines.md
 * 15.4 and 14.4). The API runs every rule (who may decide, a controlled drug's fresh step-up and
 * second person, the correction's checks and the register's witness) and answers a refusal in its
 * own words, shown as they are. The web keeps nothing.
 */

type Schemas = components["schemas"];

/** A refusal in the API's words, at the form field it belongs to where it has one. */
function apiProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  const ours =
    code.startsWith("administration_") || code.startsWith("conflict_") || code.startsWith("cd_");
  if (!detail || !ours) return problemMessage(error, t);
  const field = ADMINISTRATION_FIELD_FOR_PROBLEM[code];
  return field ? { code, message: detail, fields: { [field]: detail } } : { code, message: detail };
}

/** Decides a conflict: the first record stands, the record was corrected, or given twice. */
export async function resolveConflict(
  conflictId: string,
  body: Schemas["ResolveAdministrationConflict"],
): Promise<ActionResult<null>> {
  if (!isUuid(conflictId)) return refused(t("errors.notFound"), "not_found");
  const parsed = ResolveConflict.safeParse(body);
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  try {
    const api = await tenantApi();
    const { data, error, response } = await api.POST(
      "/v1/medicine-administration-conflicts/{id}/resolve",
      { params: { path: { id: conflictId } }, body: parsed.data },
    );
    if (!response.ok || !data) return { ok: false, ...apiProblem(error) };
    revalidatePath(medicinesHref(data.personId), "layout");
    revalidatePath(personRoundHref(data.personId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Corrects an administration record: a new record that names it, with why. */
export async function correctAdministration(
  personId: string,
  administrationId: string,
  body: Schemas["CorrectAdministration"],
): Promise<ActionResult<null>> {
  // Server actions are public endpoints: the body is parsed before anything in it is read. Only
  // what the web form sends: no other giver, whatever a crafted call holds; a controlled drug's
  // phone signatures are sent only by that phone (security review of slice 53).
  const parsed = CorrectAdministration.safeParse(
    typeof body === "object" && body !== null ? { ...body, givenBy: null } : body,
  );
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  if (!isUuid(personId) || !isUuid(administrationId) || !isUuid(parsed.data.id)) {
    return refused(t("errors.notFound"), "not_found");
  }
  if (parsed.data.controlledDrug && "deviceSignatures" in parsed.data.controlledDrug) {
    return refused(t("errors.generic"), "invalid");
  }
  try {
    const api = await tenantApi();
    const { error, response } = await api.POST("/v1/medicine-administrations/{id}/corrections", {
      params: { path: { id: administrationId } },
      body: parsed.data,
    });
    if (!response.ok) return { ok: false, ...apiProblem(error) };
    revalidatePath(medicinesHref(personId), "layout");
    revalidatePath(administrationsHref(personId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

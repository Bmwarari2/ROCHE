"use server";

import { RecordAdministration } from "@harbour/contracts";
import type { components } from "@harbour/contracts/client";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { ADMINISTRATION_FIELD_FOR_PROBLEM, personRoundHref } from "@/lib/medicine-round";
import { medicinesHref } from "@/lib/medicines";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Recording a dose on the round (slice 53; MEDS-002; medicines.md section 16). The API runs every
 * administration rule (the window, an earlier dose outstanding, the 24-hour maximum, the interval,
 * the covert record) and answers a refusal with every problem in words: those words are shown as
 * they are, at the field a reason belongs to. The web keeps nothing.
 */

type Schemas = components["schemas"];

function administrationProblem(error: unknown) {
  const problem = (error ?? {}) as { code?: unknown; detail?: unknown };
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  if (!detail || !code.startsWith("administration_")) return problemMessage(error, t);
  const field = ADMINISTRATION_FIELD_FOR_PROBLEM[code];
  return field ? { code, message: detail, fields: { [field]: detail } } : { code, message: detail };
}

/** Records one dose; what it escalated reaches the nurse in charge as a task. */
export async function recordDose(
  personId: string,
  body: Schemas["RecordAdministration"],
): Promise<ActionResult<null>> {
  if (!isUuid(personId) || !isUuid(body.id) || !isUuid(body.entryId)) {
    return refused(t("errors.notFound"), "not_found");
  }
  // Only what the web form records: a dose on the round now, at the server's time, by the person
  // signed in. A dose already given, a controlled drug's witness or another giver is not sent from
  // here (security review of slice 53), whatever a crafted call holds.
  const parsed = RecordAdministration.safeParse({
    id: body.id,
    entryId: body.entryId,
    dueAt: body.dueAt,
    outcome: body.outcome,
    reason: body.reason,
    amount: body.amount,
    amountDifferenceReason: body.amountDifferenceReason,
    timingReason: body.timingReason,
    intervalOverrideReason: body.intervalOverrideReason,
    covert: body.covert,
  });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  try {
    const api = await tenantApi();
    const { error, response } = await api.POST("/v1/people/{id}/medicine-administrations", {
      params: { path: { id: personId } },
      body: parsed.data,
    });
    if (!response.ok) return { ok: false, ...administrationProblem(error) };
    revalidatePath(medicinesHref(personId), "layout");
    revalidatePath(personRoundHref(personId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

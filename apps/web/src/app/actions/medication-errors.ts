"use server";

import {
  EditMedicationError,
  NewMedicationError,
  RecordMedicationReview,
  ScheduleMedicationReview,
} from "@harbour/contracts";
import { MEDICATION_ERROR_PROBLEM_WORDS, REVIEW_PROBLEM_WORDS } from "@harbour/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import {
  type EditMedicationErrorBody,
  ERROR_FIELD_FOR_PROBLEM,
  fieldsFromRefusal,
  medicationErrorHref,
  type NewMedicationErrorBody,
  personReviewsHref,
  REVIEW_FIELD_FOR_PROBLEM,
  type ReviewChange,
  type ScheduleReviewBody,
} from "@/lib/medication-errors";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";

/**
 * Medication errors on incidents and medication reviews (slice 55; MEDS-012, MEDS-013; medicines.md
 * section 14; HZ-134). Each body is checked against the contract and only the form's fields are
 * sent; the API runs every rule again and answers a refusal with every problem in words, which are
 * shown as they are, each at its field where the words are known. Nothing is logged.
 */

/** The reschedule and cancel bodies, from the contract's own pieces (the API's `ChangeReview`). */
const reasonWords = RecordMedicationReview.shape.correctionReason.unwrap().unwrap();
const RescheduleReview = ScheduleMedicationReview.extend({
  reason: reasonWords,
  version: RecordMedicationReview.shape.version,
});
const CancelReview = RecordMedicationReview.pick({ version: true }).extend({ reason: reasonWords });

function refusal(
  error: unknown,
  words: Readonly<Record<string, string>>,
  fieldFor: Readonly<Record<string, string | null>>,
) {
  const problem = problemMessage(error, t);
  const detail =
    typeof (error as { detail?: unknown } | null)?.detail === "string"
      ? (error as { detail: string }).detail
      : "";
  const fields = problem.code === "invalid" ? fieldsFromRefusal(detail, words, fieldFor) : {};
  return Object.keys(fields).length > 0 ? { ...problem, fields } : problem;
}

const errorRefusal = (error: unknown) =>
  refusal(error, MEDICATION_ERROR_PROBLEM_WORDS, ERROR_FIELD_FOR_PROBLEM);
const reviewRefusal = (error: unknown) =>
  refusal(error, REVIEW_PROBLEM_WORDS, REVIEW_FIELD_FOR_PROBLEM);

function errorFields(body: Omit<NewMedicationErrorBody, "personId">) {
  return {
    medicationId: body.medicationId,
    administrationId: body.administrationId,
    kinds: body.kinds,
    stage: body.stage,
    reachedPerson: body.reachedPerson,
    controlledDrug: body.controlledDrug,
    deliberateOrRepeated: body.deliberateOrRepeated,
    immediateActions: body.immediateActions,
    clinicianToldAt: body.clinicianToldAt,
    clinicianTold: body.clinicianTold,
    adviceGiven: body.adviceGiven,
    rootCause: body.rootCause,
    cdReportedOn: body.cdReportedOn,
    cdReportReference: body.cdReportReference,
  };
}

/** Adds the medication error details to a medication incident. */
export async function addMedicationError(
  incidentId: string,
  body: NewMedicationErrorBody,
): Promise<ActionResult<null>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  const parsed = NewMedicationError.safeParse({ personId: body.personId, ...errorFields(body) });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  try {
    const api = await tenantApi();
    const { error, response } = await api.POST("/v1/incidents/{id}/medication-error", {
      params: { path: { id: incidentId } },
      body: parsed.data,
    });
    if (!response.ok) return { ok: false, ...errorRefusal(error) };
    revalidatePath(`/incidents/${incidentId}`);
    revalidatePath(medicationErrorHref(incidentId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Changes them, with the version read. */
export async function changeMedicationError(
  incidentId: string,
  body: EditMedicationErrorBody,
): Promise<ActionResult<null>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  const parsed = EditMedicationError.safeParse({ ...errorFields(body), version: body.version });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  try {
    const api = await tenantApi();
    const { error, response } = await api.PATCH("/v1/incidents/{id}/medication-error", {
      params: { path: { id: incidentId } },
      body: parsed.data,
    });
    if (!response.ok) return { ok: false, ...errorRefusal(error) };
    revalidatePath(`/incidents/${incidentId}`);
    revalidatePath(medicationErrorHref(incidentId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Schedules a medication review for a person. */
export async function scheduleReview(
  personId: string,
  body: ScheduleReviewBody,
): Promise<ActionResult<null>> {
  if (!isUuid(personId)) return refused(t("errors.notFound"), "not_found");
  const parsed = ScheduleMedicationReview.safeParse({ dueOn: body.dueOn });
  if (!parsed.success) return refused(t("errors.generic"), "invalid");
  try {
    const api = await tenantApi();
    const { error, response } = await api.POST("/v1/people/{id}/medication-reviews", {
      params: { path: { id: personId } },
      body: parsed.data,
    });
    if (!response.ok) return { ok: false, ...reviewRefusal(error) };
    revalidatePath(personReviewsHref(personId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

/** Records a review done (or corrects it), moves it, or cancels it; each with what the API asks. */
export async function changeReview(
  personId: string,
  reviewId: string,
  change: ReviewChange,
): Promise<ActionResult<null>> {
  if (!isUuid(personId) || !isUuid(reviewId)) return refused(t("errors.notFound"), "not_found");
  try {
    const api = await tenantApi();
    const path = { params: { path: { id: reviewId } } };
    let outcome: { error?: unknown; response: Response };
    if (change.kind === "done") {
      const b = change.body;
      const parsed = RecordMedicationReview.safeParse({
        doneOn: b.doneOn,
        clinicianName: b.clinicianName,
        clinicianRole: b.clinicianRole,
        outcome: b.outcome,
        correctionReason: b.correctionReason ?? null,
        version: b.version,
      });
      if (!parsed.success) return refused(t("errors.generic"), "invalid");
      outcome = await api.POST("/v1/medication-reviews/{id}/done", { ...path, body: parsed.data });
    } else if (change.kind === "reschedule") {
      const b = change.body;
      const parsed = RescheduleReview.safeParse({
        dueOn: b.dueOn,
        reason: b.reason,
        version: b.version,
      });
      if (!parsed.success) return refused(t("errors.generic"), "invalid");
      outcome = await api.POST("/v1/medication-reviews/{id}/reschedule", {
        ...path,
        body: parsed.data,
      });
    } else {
      const parsed = CancelReview.safeParse({
        reason: change.body.reason,
        version: change.body.version,
      });
      if (!parsed.success) return refused(t("errors.generic"), "invalid");
      outcome = await api.POST("/v1/medication-reviews/{id}/cancel", {
        ...path,
        body: parsed.data,
      });
    }
    if (!outcome.response.ok) return { ok: false, ...reviewRefusal(outcome.error) };
    revalidatePath(personReviewsHref(personId));
    return { ok: true, data: null };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

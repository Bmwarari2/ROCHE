"use server";

import type {
  AdmissionConditionItem,
  AdmissionDecisionItem,
  CreateAdmissionDecision,
  CreateEnquiry,
  EnquiryRecorded,
  PersonStatusChangeResult,
  PreAdmissionView,
  RecordAdmission,
  UpdatePreAdmission,
  WelcomeChecklist,
} from "@harbour/contracts";
import { PRE_ADMISSION_SECTIONS } from "@harbour/domain";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import {
  CONDITION_MAX,
  enquiryRefusal,
  MAX_CONDITIONS,
  MAX_MEDICINES,
  MIN_DECISION_REASONS,
  MIN_REASON,
  NOT_APPLICABLE_REASON_MAX,
  SECTION_NOTES_MAX,
} from "@/lib/admission";
import { tenantApi } from "@/lib/api";
import { optionalText, sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, fieldErrors, problemMessage, refused } from "@/lib/outcome";
import { isIsoDate, isIsoInstant } from "@/lib/uk-time";

/**
 * Enquiries, the pre-admission assessment, the decision to admit, admission, bed moves and the
 * welcome checklist (people.md rules 1 and 4 to 6; PEOP-005, PEOP-007), sent to the API as the
 * signed-in person. The forms check what they can first so every problem shows at its field; the
 * API checks the permission, scope, version and every rule again, and refuses in its own words.
 */

const SECTION_KEYS = new Set<string>(PRE_ADMISSION_SECTIONS.map((s) => s.key));
const PLACEMENT_TYPES = new Set(["permanent", "respite", "trial", "package"]);
const SOURCES = new Set([
  "person",
  "family_or_representative",
  "hospital",
  "gp",
  "social_worker",
  "previous_provider",
  "other",
]);

const words = (value: string | undefined, max: number) => {
  const text = value?.trim() ?? "";
  return text.length > 0 && text.length <= max ? text : null;
};

// ------------------------------------------------------------------------------------------------
// Enquiries and status changes (rule 1)
// ------------------------------------------------------------------------------------------------

/** A new person record at enquiry; the list of enquiries and the new record are read again. */
export async function recordEnquiry(input: CreateEnquiry): Promise<ActionResult<EnquiryRecorded>> {
  const problems: Record<string, string> = {};
  if (!isUuid(input.locationId)) problems.locationId = t("people.enquiry.form.homeRequired");
  if (!words(input.givenName, 100)) problems.givenName = t("people.enquiry.form.givenRequired");
  if (!words(input.familyName, 100)) problems.familyName = t("people.enquiry.form.familyRequired");
  if (!isIsoDate(input.dateOfBirth)) problems.dateOfBirth = t("people.enquiry.form.dobRequired");
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  if (input.id !== undefined && !isUuid(input.id)) return refused(t("care.errors.invalid"));
  if (input.receivedAt !== undefined && !isIsoInstant(input.receivedAt)) {
    return refused(t("care.errors.whenRequired"), "invalid", ["receivedAt"]);
  }
  const preferredName = optionalText(input.preferredName);
  try {
    const api = await tenantApi();
    const { data, error } = await api.POST("/v1/people", {
      body: {
        ...(input.id ? { id: input.id } : {}),
        locationId: input.locationId,
        givenName: input.givenName.trim(),
        familyName: input.familyName.trim(),
        ...(preferredName ? { preferredName } : {}),
        dateOfBirth: input.dateOfBirth,
        ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
      },
    });
    if (data) {
      revalidatePath("/people", "layout");
      return { ok: true, data };
    }
    return enquiryRefusal(error, t);
  } catch (error) {
    // Redirects (the session ended) go through as navigation.
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

type StatusMove =
  | {
      readonly to: "pre_admission";
      readonly serviceId: string;
      readonly placementTypeSought: string;
    }
  | { readonly to: "not_admitted" | "enquiry"; readonly reason: string };

/**
 * Starts the pre-admission assessment, closes an enquiry as not admitted, or records a
 * re-referral (PERSON_LIFECYCLE, people.enquiry.manage). "Now" is the moment it is sent.
 */
export async function changeEnquiryStatus(
  personId: string,
  version: number,
  move: StatusMove,
): Promise<ActionResult<PersonStatusChangeResult>> {
  if (!Number.isInteger(version) || version < 1) return refused(t("care.errors.invalid"));
  if (move.to === "pre_admission") {
    const problems: Record<string, string> = {};
    if (!isUuid(move.serviceId))
      problems.serviceId = t("people.preAdmission.start.serviceRequired");
    if (!PLACEMENT_TYPES.has(move.placementTypeSought)) {
      problems.placementTypeSought = t("people.preAdmission.start.typeRequired");
    }
    if (Object.keys(problems).length > 0) return fieldErrors(problems);
  } else if (move.reason.trim().length < MIN_REASON || move.reason.trim().length > 1000) {
    return refused(t("people.preAdmission.close.reasonRequired"), "invalid", ["reason"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/status", {
      params: { path: { id: personId } },
      body:
        move.to === "pre_admission"
          ? {
              to: "pre_admission",
              effectiveAt: new Date().toISOString(),
              serviceId: move.serviceId,
              placementTypeSought: move.placementTypeSought as "permanent",
              version,
            }
          : {
              to: move.to,
              effectiveAt: new Date().toISOString(),
              reason: move.reason.trim(),
              version,
            },
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// The pre-admission assessment (rule 4)
// ------------------------------------------------------------------------------------------------

type SectionInput = NonNullable<
  UpdatePreAdmission["sections"][keyof UpdatePreAdmission["sections"]]
>;

/** One section of the assessment, sent with the assessment's version. */
export async function saveAssessmentSection(
  personId: string,
  version: number,
  key: string,
  input: SectionInput,
): Promise<ActionResult<PreAdmissionView>> {
  if (!SECTION_KEYS.has(key) || !Number.isInteger(version) || version < 1) {
    return refused(t("care.errors.invalid"));
  }
  const notes = optionalText(input.notes);
  if (notes && notes.length > SECTION_NOTES_MAX) {
    return refused(t("people.preAdmission.section.notesTooLong"), "invalid", ["notes"]);
  }
  const listed = key === "medicines" && (input.medicines?.length ?? 0) > 0;
  if (input.status === "complete" && !notes && !listed) {
    return refused(t("people.preAdmission.section.notesRequired"), "invalid", ["notes"]);
  }
  const reason = optionalText(input.notApplicableReason);
  if (
    input.status === "not_applicable" &&
    (!reason || reason.length < MIN_REASON || reason.length > NOT_APPLICABLE_REASON_MAX)
  ) {
    return refused(t("people.preAdmission.section.reasonRequired"), "invalid", [
      "notApplicableReason",
    ]);
  }
  if (input.medicines && (key !== "medicines" || input.medicines.length > MAX_MEDICINES)) {
    return refused(t("care.errors.invalid"), "invalid", ["medicines"]);
  }
  const section: SectionInput = {
    status: input.status,
    ...(notes ? { notes } : {}),
    ...(input.status === "not_applicable" && reason ? { notApplicableReason: reason } : {}),
    ...(key === "medicines" ? { medicines: input.medicines ?? [] } : {}),
  };
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/pre-admission", {
      params: { path: { id: personId } },
      body: { sections: { [key]: section }, version },
    }),
  );
}

/** Who the information came from, and how the person took part (Regulation 9). */
export async function saveAssessmentSources(
  personId: string,
  version: number,
  input: {
    readonly informationSources: readonly string[];
    readonly involved: boolean | null;
    readonly reason: string;
  },
): Promise<ActionResult<PreAdmissionView>> {
  if (!Number.isInteger(version) || version < 1) return refused(t("care.errors.invalid"));
  const problems: Record<string, string> = {};
  const sources = [...new Set(input.informationSources)].filter((s) => SOURCES.has(s));
  if (sources.length === 0) problems.informationSources = t("people.preAdmission.sources.required");
  if (input.involved === null) problems.involved = t("people.preAdmission.involvement.required");
  const reason = input.reason.trim();
  if (input.involved === false && (reason.length < MIN_REASON || reason.length > 1000)) {
    problems.involvementReason = t("people.preAdmission.involvement.reasonRequired");
  }
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/pre-admission", {
      params: { path: { id: personId } },
      body: {
        sections: {},
        informationSources: sources as UpdatePreAdmission["informationSources"],
        personInvolvement: input.involved ? { involved: true } : { involved: false, reason },
        version,
      },
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// The decision to admit (rule 5)
// ------------------------------------------------------------------------------------------------

export async function recordDecision(
  personId: string,
  input: CreateAdmissionDecision,
): Promise<ActionResult<AdmissionDecisionItem>> {
  const problems: Record<string, string> = {};
  if (!["yes", "yes_with_conditions", "no"].includes(input.canMeetNeeds)) {
    problems.canMeetNeeds = t("people.decision.form.answerRequired");
  }
  const reasons = input.reasons.trim();
  if (reasons.length < MIN_DECISION_REASONS || reasons.length > 4000) {
    problems.reasons = t("people.decision.form.reasonsRequired", { min: MIN_DECISION_REASONS });
  }
  const conditions = input.conditions.map((c) => c.trim()).filter((c) => c !== "");
  if (input.canMeetNeeds === "yes_with_conditions" && conditions.length === 0) {
    problems.conditions = t("people.decision.form.conditionsRequired");
  }
  if (conditions.length > MAX_CONDITIONS || conditions.some((c) => c.length > CONDITION_MAX)) {
    problems.conditions = t("people.decision.form.conditionsTooMany", { max: MAX_CONDITIONS });
  }
  for (const field of ["plannedAdmissionOn", "trialEndsOn"] as const) {
    const value = input[field];
    if (value !== undefined && !isIsoDate(value)) problems[field] = t("care.errors.invalid");
  }
  const toldWho = optionalText(input.toldWho);
  if ((toldWho === undefined) !== (input.toldAt === undefined)) {
    problems[toldWho ? "toldAt" : "toldWho"] = t("people.decision.form.toldBoth");
  } else if (input.toldAt !== undefined && !isIsoInstant(input.toldAt)) {
    problems.toldAt = t("care.errors.invalid");
  }
  if (input.supersedesId !== undefined) {
    const why = input.correctionReason?.trim() ?? "";
    if (!isUuid(input.supersedesId) || why.length < MIN_REASON || why.length > 500) {
      problems.correctionReason = t("people.decision.form.correctionRequired");
    }
  }
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/admission-decisions", {
      params: { path: { id: personId } },
      body: {
        canMeetNeeds: input.canMeetNeeds,
        reasons,
        conditions: input.canMeetNeeds === "yes_with_conditions" ? conditions : [],
        ...(input.plannedAdmissionOn ? { plannedAdmissionOn: input.plannedAdmissionOn } : {}),
        ...(input.trialEndsOn ? { trialEndsOn: input.trialEndsOn } : {}),
        ...(toldWho && input.toldAt ? { toldWho, toldAt: input.toldAt } : {}),
        ...(input.supersedesId
          ? { supersedesId: input.supersedesId, correctionReason: input.correctionReason?.trim() }
          : {}),
      },
    }),
  );
}

export async function confirmCondition(
  personId: string,
  decisionId: string,
  conditionId: string,
  version: number,
): Promise<ActionResult<AdmissionConditionItem>> {
  if (!isUuid(decisionId) || !isUuid(conditionId) || !Number.isInteger(version)) {
    return refused(t("care.errors.invalid"));
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/admission-decisions/{decisionId}/conditions/{conditionId}/met", {
      params: { path: { id: personId, decisionId, conditionId } },
      body: { version },
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Admission, beds and the welcome checklist (rules 5 and 6)
// ------------------------------------------------------------------------------------------------

export async function admitPerson(
  personId: string,
  input: RecordAdmission,
): Promise<ActionResult<unknown>> {
  const problems: Record<string, string> = {};
  if (!isUuid(input.serviceId)) problems.serviceId = t("people.admission.form.serviceRequired");
  if (!PLACEMENT_TYPES.has(input.placementType)) {
    problems.placementType = t("people.admission.form.typeRequired");
  }
  if (!isIsoDate(input.startDate)) problems.startDate = t("people.admission.form.startRequired");
  if (input.placementType === "trial" && !input.trialEndsOn) {
    problems.trialEndsOn = t("people.admission.form.trialRequired");
  } else if (input.trialEndsOn !== undefined && !isIsoDate(input.trialEndsOn)) {
    problems.trialEndsOn = t("care.errors.invalid");
  }
  if (input.placementType !== "package" && !isUuid(input.roomId)) {
    problems.bed = t("people.admission.form.bedRequired");
  }
  if (!isIsoInstant(input.admittedAt)) problems.admittedAt = t("care.errors.whenRequired");
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/admission", {
      params: { path: { id: personId } },
      body: {
        serviceId: input.serviceId,
        placementType: input.placementType,
        startDate: input.startDate,
        ...(input.placementType === "trial" && input.trialEndsOn
          ? { trialEndsOn: input.trialEndsOn }
          : {}),
        localAuthorityFunded: input.localAuthorityFunded === true,
        nhsFunded: input.nhsFunded === true,
        ...(input.placementType !== "package" && input.roomId ? { roomId: input.roomId } : {}),
        bed: input.bed ?? 1,
        admittedAt: input.admittedAt,
        version: input.version,
      },
    }),
  );
}

export async function moveBed(
  personId: string,
  input: {
    readonly roomId: string;
    readonly bed: number;
    readonly on: string;
    readonly reason: string;
    readonly version: number;
  },
): Promise<ActionResult<unknown>> {
  const problems: Record<string, string> = {};
  if (!isUuid(input.roomId) || !Number.isInteger(input.bed)) {
    problems.bed = t("people.room.move.bedRequired");
  }
  if (!isIsoDate(input.on)) problems.on = t("people.room.move.dateRequired");
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON || reason.length > 500) {
    problems.reason = t("people.room.move.reasonRequired");
  }
  if (Object.keys(problems).length > 0) return fieldErrors(problems);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/bed-moves", {
      params: { path: { id: personId } },
      body: { roomId: input.roomId, bed: input.bed, on: input.on, reason, version: input.version },
    }),
  );
}

export async function updateChecklistItem(
  personId: string,
  itemKey: string,
  input: {
    readonly status: "pending" | "done" | "not_applicable";
    readonly reason?: string;
    readonly version: number;
  },
): Promise<ActionResult<WelcomeChecklist>> {
  if (!/^[a-z0-9_.-]{1,80}$/i.test(itemKey) || !Number.isInteger(input.version)) {
    return refused(t("care.errors.invalid"));
  }
  const reason = input.reason?.trim() ?? "";
  if (input.status === "not_applicable" && (reason.length < MIN_REASON || reason.length > 500)) {
    return refused(t("people.checklist.reasonRequired"), "invalid", ["reason"]);
  }
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/welcome-checklist/{itemKey}", {
      params: { path: { id: personId, itemKey } },
      body: {
        status: input.status,
        ...(input.status === "not_applicable" ? { reason } : {}),
        version: input.version,
      },
    }),
  );
}

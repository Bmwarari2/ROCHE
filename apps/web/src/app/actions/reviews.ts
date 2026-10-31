"use server";

import type {
  CarePlanChangeOut,
  CreateCarePlanChange,
  CreateReviewRecord,
  ReviewRecordOut,
} from "@harbour/contracts";
import { optionalText, sendForPerson } from "@/lib/care-actions";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import {
  CARE_PLAN_CHANGE_KINDS,
  FAMILY_INVOLVEMENT_KINDS,
  MAX_PARTICIPANT_LENGTH,
  MAX_PARTICIPANTS,
  participantsFromLines,
  REVIEW_RECORD_KINDS,
} from "@/lib/reviews";
import { isIsoDate } from "@/lib/uk-time";

/**
 * Writes for the reviews tab (people.md rule 8 and section 6a; PEOP-008; HZ-008). Review records
 * are append-only; the API completes the open review task and marks the changes a care plan
 * review covers. `care.plan.write`, checked again by the API.
 */

export interface ReviewInput {
  readonly kind: string;
  readonly heldOn: string;
  /** One role per line. */
  readonly participants: string;
  readonly familyInvolvementKind: string;
  readonly laReference: string;
  readonly outcome: string;
}

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

export async function recordReview(
  personId: string,
  input: ReviewInput,
): Promise<ActionResult<ReviewRecordOut>> {
  if (!isOneOf(REVIEW_RECORD_KINDS, input.kind)) {
    return refused(t("care.errors.invalid"), "invalid", ["kind"]);
  }
  if (!isIsoDate(input.heldOn)) {
    return refused(t("care.date.empty", { subject: t("care.date.subject.heldOn") }), "invalid", [
      "heldOn",
    ]);
  }
  const participants = participantsFromLines(input.participants);
  if ("problem" in participants) {
    return refused(
      participants.problem === "too_many"
        ? t("people.reviews.form.tooMany", { max: MAX_PARTICIPANTS })
        : t("people.reviews.form.tooLong", { max: MAX_PARTICIPANT_LENGTH }),
      "invalid",
      ["participants"],
    );
  }
  const family = input.familyInvolvementKind;
  if (input.kind === "family_involvement" && !isOneOf(FAMILY_INVOLVEMENT_KINDS, family)) {
    return refused(t("people.reviews.form.familyKindRequired"), "invalid", [
      "familyInvolvementKind",
    ]);
  }
  const laReference = input.kind === "la_review" ? optionalText(input.laReference) : undefined;
  const outcome = optionalText(input.outcome);
  const body: CreateReviewRecord = {
    kind: input.kind,
    heldOn: input.heldOn,
    participants,
    ...(input.kind === "family_involvement" && isOneOf(FAMILY_INVOLVEMENT_KINDS, family)
      ? { familyInvolvementKind: family }
      : {}),
    ...(laReference ? { laReference } : {}),
    ...(outcome ? { outcome } : {}),
  };
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/reviews", { params: { path: { id: personId } }, body }),
  );
}

export async function recordCarePlanChange(
  personId: string,
  input: { readonly kind: string; readonly occurredOn: string },
): Promise<ActionResult<CarePlanChangeOut>> {
  if (!isOneOf(CARE_PLAN_CHANGE_KINDS, input.kind)) {
    return refused(t("care.errors.invalid"), "invalid", ["kind"]);
  }
  if (!isIsoDate(input.occurredOn)) {
    return refused(
      t("care.date.empty", { subject: t("care.date.subject.occurredOn") }),
      "invalid",
      ["occurredOn"],
    );
  }
  const body: CreateCarePlanChange = { kind: input.kind, occurredOn: input.occurredOn };
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/care-plan-changes", { params: { path: { id: personId } }, body }),
  );
}

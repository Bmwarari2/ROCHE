"use server";

import type {
  CarePlanActionItem,
  CarePlanDetail,
  CarePlanSectionItem,
  CloseRiskAssessment,
  CreateRiskAssessment,
  PcspDomain,
  RiskAssessmentItem,
  SignOffCarePlan,
  UpdateRiskAssessment,
} from "@harbour/contracts";
import { optionalText, sendForPerson } from "@/lib/care-actions";
import { isPcspDomain } from "@/lib/care-plan";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoDate } from "@/lib/uk-time";

/**
 * Writes for care plans and risk assessments (care.md slice 4b, hazard HZ-024). A plan is edited
 * only as a draft; publishing puts it in use and supersedes the plan in use, which stays readable.
 * Mutable records carry the version the person read, so two people cannot overwrite each other.
 */

const checkIds = (...ids: string[]) => ids.every((id) => isUuid(id));

export async function startCarePlanDraft(personId: string): Promise<ActionResult<CarePlanDetail>> {
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/care-plans", {
      params: { path: { id: personId } },
      body: { copyFromActive: true },
    }),
  );
}

export interface SectionInput {
  readonly need: string;
  readonly outcome: string;
  readonly strengths: string;
  readonly contingency: string;
  /** The version read; 0 when the section is new. */
  readonly version: number;
}

export async function saveCarePlanSection(
  personId: string,
  planId: string,
  domain: PcspDomain,
  input: SectionInput,
): Promise<ActionResult<CarePlanSectionItem>> {
  if (!checkIds(planId) || !isPcspDomain(domain)) return refused(t("errors.notFound"), "not_found");
  const text = (value: string) => optionalText(value) ?? null;
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/care-plans/{planId}/sections/{domain}", {
      params: { path: { id: personId, planId, domain } },
      body: {
        need: text(input.need),
        outcome: text(input.outcome),
        strengths: text(input.strengths),
        contingency: text(input.contingency),
        version: input.version,
      },
    }),
  );
}

export interface ActionInput {
  readonly action: string;
  readonly roleKey: string;
  readonly whenText: string;
  readonly evidenceRequired: boolean;
}

export async function addCarePlanAction(
  personId: string,
  planId: string,
  domain: PcspDomain,
  input: ActionInput,
): Promise<ActionResult<CarePlanActionItem>> {
  if (!checkIds(planId) || !isPcspDomain(domain)) return refused(t("errors.notFound"), "not_found");
  const action = input.action.trim();
  if (action.length < 3) return refused(t("care.plan.edit.actionRequired"), "invalid", ["action"]);
  const roleKey = optionalText(input.roleKey);
  const whenText = optionalText(input.whenText);
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/care-plans/{planId}/sections/{domain}/actions", {
      params: { path: { id: personId, planId, domain } },
      body: {
        action,
        ...(roleKey ? { roleKey } : {}),
        ...(whenText ? { whenText } : {}),
        // Task generation needs a schedule (slice 5); actions from the web are described in words.
        generatesTasks: false,
        evidenceRequired: input.evidenceRequired,
      },
    }),
  );
}

export async function removeCarePlanAction(
  personId: string,
  planId: string,
  actionId: string,
  version: number,
): Promise<ActionResult<CarePlanActionItem>> {
  if (!checkIds(planId, actionId)) return refused(t("errors.notFound"), "not_found");
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/care-plans/{planId}/actions/{actionId}", {
      params: { path: { id: personId, planId, actionId } },
      body: { removed: true, version },
    }),
  );
}

export interface PublishInput {
  readonly version: number;
  readonly agreedBy: SignOffCarePlan["agreedBy"] | null;
  readonly representativeName: string;
  readonly authority: SignOffCarePlan["authority"] | "";
  readonly unableReason: string;
  /** An earlier review date (yyyy-mm-dd), or empty for the usual interval. */
  readonly reviewDueOn: string;
}

/**
 * Records who agreed the draft, then publishes it. Sign-off first, so a plan is never put in use
 * without saying who agreed it or why no one could; the API checks the representative's authority.
 */
export async function publishCarePlan(
  personId: string,
  planId: string,
  input: PublishInput,
): Promise<ActionResult<CarePlanDetail>> {
  if (!checkIds(planId)) return refused(t("errors.notFound"), "not_found");
  if (!input.agreedBy) {
    return refused(t("care.plan.publish.agreedRequired"), "invalid", ["agreedBy"]);
  }
  const reviewDueOn = input.reviewDueOn.trim();
  if (reviewDueOn && !isIsoDate(reviewDueOn)) {
    return refused(t("care.errors.invalid"), "invalid", ["reviewDueOn"]);
  }
  const representativeName = optionalText(input.representativeName);
  const unableReason = optionalText(input.unableReason);
  const signedOff = await sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/care-plans/{planId}/sign-off", {
      params: { path: { id: personId, planId } },
      body: {
        agreedBy: input.agreedBy ?? "person",
        version: input.version,
        ...(input.agreedBy === "representative"
          ? {
              ...(representativeName ? { representativeName } : {}),
              ...(input.authority ? { authority: input.authority } : {}),
            }
          : {}),
        ...(input.agreedBy === "unable" && unableReason ? { unableReason } : {}),
      },
    }),
  );
  if (!signedOff.ok) return signedOff;
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/care-plans/{planId}/publish", {
      params: { path: { id: personId, planId } },
      body: { version: signedOff.data.version, ...(reviewDueOn ? { reviewDueOn } : {}) },
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// Risk assessments
// ------------------------------------------------------------------------------------------------

export async function recordRiskAssessment(
  personId: string,
  input: CreateRiskAssessment,
): Promise<ActionResult<RiskAssessmentItem>> {
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/risk-assessments", {
      params: { path: { id: personId } },
      body: input,
    }),
  );
}

export async function reviewRiskAssessment(
  personId: string,
  riskId: string,
  input: UpdateRiskAssessment,
): Promise<ActionResult<RiskAssessmentItem>> {
  if (!checkIds(riskId)) return refused(t("errors.notFound"), "not_found");
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/risk-assessments/{riskId}", {
      params: { path: { id: personId, riskId } },
      body: input,
    }),
  );
}

export async function closeRiskAssessment(
  personId: string,
  riskId: string,
  input: CloseRiskAssessment,
): Promise<ActionResult<RiskAssessmentItem>> {
  if (!checkIds(riskId)) return refused(t("errors.notFound"), "not_found");
  if (input.reason.trim().length < 3) {
    return refused(t("care.risk.close.reasonRequired"), "invalid", ["reason"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/risk-assessments/{riskId}/close", {
      params: { path: { id: personId, riskId } },
      body: { reason: input.reason.trim(), version: input.version },
    }),
  );
}

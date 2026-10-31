"use server";

import type {
  AboutMeOut,
  AboutMeShareLinkCreated,
  AboutMeShareLinkOut,
  CreateSharingDecision,
  SharingDecisionOut,
  UpdateAboutMe,
} from "@harbour/contracts";
import { sendForPerson } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoInstant } from "@/lib/uk-time";

/**
 * About Me, its share links and sharing decisions (PEOP-003 and PEOP-013; people.md rules 9 and
 * 13; HZ-022), sent to the API as the signed-in member of staff. Mutable records carry the version
 * they were loaded at. The API decides what is in force and refuses anything it would not keep;
 * making a link needs a fresh sign-in (step-up), which the form asks for when the API says so.
 */

const REASON_MIN = 3;
const REASON_MAX = 1000;

const isVersion = (value: unknown, min = 1): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min;

function reasonProblem(reason: string): ActionResult<never> | null {
  const trimmed = reason.trim();
  return trimmed.length < REASON_MIN || trimmed.length > REASON_MAX
    ? refused(t("people.sharing.reasonError"), "invalid", ["reason"])
    : null;
}

export async function saveAboutMe(
  personId: string,
  update: Omit<UpdateAboutMe, "version">,
  version: number,
): Promise<ActionResult<AboutMeOut>> {
  if (!isVersion(version, 0)) return refused(t("care.errors.invalid"));
  return sendForPerson(personId, (api) =>
    api.PUT("/v1/people/{id}/about-me", {
      params: { path: { id: personId } },
      body: { ...update, version },
    }),
  );
}

export async function recordSharingDecision(
  personId: string,
  decision: CreateSharingDecision,
): Promise<ActionResult<SharingDecisionOut>> {
  if (!isIsoInstant(decision.validTo)) {
    return refused(t("people.sharing.form.validToRequired"), "invalid", ["validTo"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/sharing-decisions", {
      params: { path: { id: personId } },
      body: decision,
    }),
  );
}

export type DecisionAction = "suspend" | "lift" | "withdraw";

const DECISION_ACTIONS: readonly DecisionAction[] = ["suspend", "lift", "withdraw"];

/** Suspend, lift a suspension or withdraw, with the reason; the sections close or open at once. */
export async function closeSharingDecision(
  personId: string,
  decisionId: string,
  action: DecisionAction,
  reason: string,
  version: number,
): Promise<ActionResult<SharingDecisionOut>> {
  if (!isUuid(decisionId) || !DECISION_ACTIONS.includes(action)) {
    return refused(t("errors.notFound"), "not_found");
  }
  if (!isVersion(version)) return refused(t("care.errors.invalid"));
  const problem = reasonProblem(reason);
  if (problem) return problem;
  const init = {
    params: { path: { id: personId, decisionId } },
    body: { reason: reason.trim(), version },
  };
  return sendForPerson(personId, (api) => {
    switch (action) {
      case "suspend":
        return api.POST("/v1/people/{id}/sharing-decisions/{decisionId}/suspend", init);
      case "lift":
        return api.POST("/v1/people/{id}/sharing-decisions/{decisionId}/lift-suspension", init);
      case "withdraw":
        return api.POST("/v1/people/{id}/sharing-decisions/{decisionId}/withdraw", init);
    }
  });
}

/** Make an expiring link to About Me under a decision; the code comes back this once only. */
export async function makeShareLink(
  personId: string,
  sharingDecisionId: string,
  expiresAt: string,
): Promise<ActionResult<AboutMeShareLinkCreated>> {
  if (!isUuid(sharingDecisionId)) {
    return refused(t("people.links.form.decisionRequired"), "invalid", ["sharingDecisionId"]);
  }
  if (!isIsoInstant(expiresAt)) {
    return refused(t("people.links.form.expiresPast"), "invalid", ["expiresAt"]);
  }
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/about-me/links", {
      params: { path: { id: personId } },
      body: { sharingDecisionId, expiresAt },
    }),
  );
}

export async function revokeShareLink(
  personId: string,
  linkId: string,
  reason: string,
  version: number,
): Promise<ActionResult<AboutMeShareLinkOut>> {
  if (!isUuid(linkId)) return refused(t("errors.notFound"), "not_found");
  if (!isVersion(version)) return refused(t("care.errors.invalid"));
  const problem = reasonProblem(reason);
  if (problem) return problem;
  return sendForPerson(personId, (api) =>
    api.POST("/v1/people/{id}/about-me/links/{linkId}/revoke", {
      params: { path: { id: personId, linkId } },
      body: { reason: reason.trim(), version },
    }),
  );
}

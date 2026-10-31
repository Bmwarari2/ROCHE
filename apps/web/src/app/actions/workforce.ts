"use server";

import type { ApiClient } from "@harbour/contracts/client";
import { wallClockAt } from "@harbour/ui";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { type ActionResult, problemMessage, refused } from "@/lib/outcome";
import type { WorkforceValues } from "@/lib/workforce";

/**
 * The workforce screens' writes (plan slice 58): recruitment, induction, leaving and casework.
 * Each goes to the API as the signed-in person, which checks the permission, the version loaded,
 * step-up and every rule again; the web holds nothing of its own. The values come from
 * `WorkforceForm`, already checked for what is required.
 */

type Values = WorkforceValues;

async function send<T>(
  call: (api: ApiClient) => Promise<{ data?: T; error?: unknown }>,
): Promise<ActionResult<T>> {
  try {
    const api = await tenantApi();
    const { data, error } = await call(api);
    if (data !== undefined) {
      revalidatePath("/workforce", "layout");
      return { ok: true, data };
    }
    return { ok: false, ...problemMessage(error, t) };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, ...problemMessage(undefined, t) };
  }
}

const str = (v: Values, k: string): string | null => {
  const value = v[k];
  return typeof value === "string" && value !== "" ? value : null;
};
const req = (v: Values, k: string): string => str(v, k) ?? "";
const bool = (v: Values, k: string): boolean => v[k] === true;
const int = (v: Values, k: string): number => Number.parseInt(req(v, k), 10);
const lines = (value: string | null): string[] =>
  (value ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
/** A UK date and time (hh:mm) as an instant, through the UK offset in force then. */
function ukInstant(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  const wall = wallClockAt(asUtc);
  const offset = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - asUtc;
  return new Date(asUtc - offset).toISOString();
}
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const bad = (): ActionResult<never> => refused(t("workforce.form.notFound"), "not_found");

// Recruitment (WORK-001).

export async function createJobTemplate(values: Values): Promise<ActionResult<unknown>> {
  const questions = lines(str(values, "valuesQuestions")).map((line, i) => {
    const colon = line.indexOf(":");
    const value = colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
    return { key: `q${i + 1}`, value, question: colon > 0 ? line.slice(colon + 1).trim() : line };
  });
  return send((api) =>
    api.POST("/v1/workforce/job-templates", {
      body: {
        title: req(values, "title"),
        pathwayCategory: req(values, "pathwayCategory") as never,
        registrationBody: (str(values, "registrationBody") ?? null) as never,
        essentialCriteria: lines(str(values, "essentialCriteria")),
        valuesQuestions: questions as never,
      },
    }),
  );
}

export async function createVacancy(values: Values): Promise<ActionResult<unknown>> {
  const template = req(values, "jobTemplateId");
  if (!isUuid(template))
    return refused(t("workforce.recruitment.templateRequired"), "invalid", ["jobTemplateId"]);
  const location = str(values, "locationId");
  return send((api) =>
    api.POST("/v1/workforce/vacancies", {
      body: {
        jobTemplateId: template,
        locationId: location && isUuid(location) ? location : null,
        title: req(values, "title"),
        positions: Number.isFinite(int(values, "positions")) ? int(values, "positions") : 1,
        opensOn: req(values, "opensOn"),
        closesOn: str(values, "closesOn"),
        status: bool(values, "open") ? "open" : "draft",
      },
    }),
  );
}

export async function changeVacancyStatus(
  vacancyId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(vacancyId)) return bad();
  return send((api) =>
    api.PATCH("/v1/workforce/vacancies/{id}", {
      params: { path: { id: vacancyId } },
      body: { status: req(values, "status") as never, expectedVersion: version },
    }),
  );
}

export async function addApplication(
  vacancyId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(vacancyId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/vacancies/{id}/applications", {
      params: { path: { id: vacancyId } },
      body: {
        givenName: req(values, "givenName"),
        familyName: req(values, "familyName"),
        email: str(values, "email"),
        phone: str(values, "phone"),
      },
    }),
  );
}

export async function shortlistApplication(
  applicationId: string,
  version: number,
  criteria: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(applicationId)) return bad();
  const met = Array.from({ length: criteria }, (_, i) => bool(values, `criterion${i}`));
  const decision = met.every(Boolean) ? "shortlist" : "reject";
  return send((api) =>
    api.POST("/v1/workforce/applications/{id}/shortlist", {
      params: { path: { id: applicationId } },
      body: {
        criteria: met,
        decision,
        ...(decision === "reject" ? { reason: "criteria_not_met" as const } : {}),
        expectedVersion: version,
      },
    }),
  );
}

export async function closeApplication(
  applicationId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(applicationId)) return bad();
  const reason = req(values, "reason");
  return send((api) =>
    api.POST("/v1/workforce/applications/{id}/close", {
      params: { path: { id: applicationId } },
      body: {
        to: reason === "applicant_withdrew" ? "withdrawn" : "rejected",
        reason: reason as never,
        expectedVersion: version,
      },
    }),
  );
}

export async function recordInterview(
  applicationId: string,
  version: number,
  questionKeys: readonly string[],
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(applicationId)) return bad();
  const panel = ["panel1", "panel2", "panel3"]
    .map((k) => str(values, k))
    .filter((v): v is string => v !== null && isUuid(v));
  const scores = Object.fromEntries(questionKeys.map((k) => [k, int(values, `score_${k}`)]));
  return send((api) =>
    api.POST("/v1/workforce/applications/{id}/interviews", {
      params: { path: { id: applicationId } },
      body: {
        heldOn: req(values, "heldOn"),
        panel: [...new Set(panel)],
        scores,
        notes: str(values, "notes"),
        recommendation: req(values, "recommendation") as never,
        expectedVersion: version,
      },
    }),
  );
}

export async function makeOffer(
  applicationId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(applicationId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/applications/{id}/offer", {
      params: { path: { id: applicationId } },
      body: {
        proposedStartOn: str(values, "proposedStartOn"),
        previousCareWork: bool(values, "previousCareWork"),
        expectedVersion: version,
      },
    }),
  );
}

export async function respondToOffer(
  offerId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(offerId)) return bad();
  const response = req(values, "response");
  const member = str(values, "tenantUserId");
  if (response === "accepted" && (!member || !isUuid(member))) {
    return refused(t("workforce.recruitment.memberRequired"), "invalid", ["tenantUserId"]);
  }
  return send((api) =>
    api.POST("/v1/workforce/offers/{id}/response", {
      params: { path: { id: offerId } },
      body:
        response === "accepted"
          ? { response: "accepted", tenantUserId: member as string, expectedVersion: version }
          : {
              response: response === "withdrawn" ? "withdrawn" : "declined",
              expectedVersion: version,
            },
    }),
  );
}

// Induction and the Care Certificate (WORK-004).

export async function setInductionPlan(
  profileId: string,
  version: number | null,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.PUT("/v1/workforce/staff-files/{id}/induction", {
      params: { path: { id: profileId } },
      body: {
        ...(version !== null ? { expectedVersion: version } : {}),
        probationEndsOn: str(values, "probationEndsOn"),
        careCertificateHeld: bool(values, "careCertificateHeld"),
      },
    }),
  );
}

export async function tickInductionItem(
  profileId: string,
  kind: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/induction/items/{kind}", {
      params: { path: { id: profileId, kind: kind as never } },
      body: { doneOn: req(values, "doneOn") },
    }),
  );
}

export async function recordShadowShift(
  profileId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/induction/shadow-shifts", {
      params: { path: { id: profileId } },
      body: {
        shiftOn: req(values, "shiftOn"),
        shadowedId: req(values, "shadowedId"),
        locationId: null,
      },
    }),
  );
}

export async function recordProbationReview(
  profileId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/induction/probation-reviews", {
      params: { path: { id: profileId } },
      body: {
        reviewOn: req(values, "reviewOn"),
        outcome: req(values, "outcome") as never,
        notes: str(values, "notes"),
      },
    }),
  );
}

export async function decideProbation(
  profileId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/induction/probation-decision", {
      params: { path: { id: profileId } },
      body: {
        expectedVersion: version,
        outcome: req(values, "outcome") as never,
        decidedOn: req(values, "decidedOn"),
        newEndsOn: str(values, "newEndsOn"),
      },
    }),
  );
}

export async function recordCareCertificateStep(
  profileId: string,
  standardId: string,
  step: "knowledge" | "observation",
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.PUT("/v1/workforce/staff-files/{id}/care-certificate/{standardId}", {
      params: { path: { id: profileId, standardId: standardId as never } },
      body: { step, on: req(values, "on") },
    }),
  );
}

// Leaving (WORK-013).

export async function recordLeaving(
  profileId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/leaving", {
      params: { path: { id: profileId } },
      body: { leavingOn: req(values, "leavingOn"), reason: req(values, "reason") as never },
    }),
  );
}

export async function tickLeaverItem(
  profileId: string,
  kind: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/leaving/items/{kind}", {
      params: { path: { id: profileId, kind: kind as never } },
      body: { doneOn: req(values, "doneOn") },
    }),
  );
}

export async function recordExitInterview(
  profileId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  const state = req(values, "state");
  return send((api) =>
    api.PUT("/v1/workforce/staff-files/{id}/leaving/exit-interview", {
      params: { path: { id: profileId } },
      body: {
        expectedVersion: version,
        state: state as never,
        heldOn: state === "held" ? str(values, "heldOn") : null,
        summary: state === "held" ? str(values, "summary") : null,
      },
    }),
  );
}

export async function endLeaverAccess(
  profileId: string,
  _values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/leaving/end-access", {
      params: { path: { id: profileId } },
    }),
  );
}

export async function recordReferenceRequest(
  profileId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/staff-files/{id}/references", {
      params: { path: { id: profileId } },
      body: {
        requestedOn: req(values, "requestedOn"),
        requester: req(values, "requester"),
        kind: req(values, "kind") as never,
      },
    }),
  );
}

export async function answerReferenceRequest(
  profileId: string,
  referenceId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(profileId) || !isUuid(referenceId)) return bad();
  const sent = req(values, "state") === "sent";
  return send((api) =>
    api.PATCH("/v1/workforce/staff-files/{id}/references/{referenceId}", {
      params: { path: { id: profileId, referenceId } },
      body: {
        expectedVersion: version,
        state: sent ? "sent" : "declined",
        sentOn: sent ? str(values, "sentOn") : null,
        declinedReason: sent ? null : (str(values, "declinedReason") as never),
      },
    }),
  );
}

// Employee relations casework (WORK-010): a restricted silo (ADR-0089).

export async function openCase(values: Values): Promise<ActionResult<{ case: { id: string } }>> {
  const subject = req(values, "subjectTenantUserId");
  if (!isUuid(subject)) {
    return refused(t("workforce.cases.subjectRequired"), "invalid", ["subjectTenantUserId"]);
  }
  return send((api) =>
    api.POST("/v1/workforce/cases", {
      body: {
        caseType: req(values, "caseType") as never,
        subjectTenantUserId: subject,
        summary: req(values, "summary"),
        openedOn: req(values, "openedOn"),
      },
    }),
  );
}

export async function nameCaseMember(
  caseId: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/cases/{id}/members", {
      params: { path: { id: caseId } },
      body: {
        tenantUserId: req(values, "tenantUserId"),
        role: req(values, "role") as never,
        independenceException: bool(values, "exception") ? "no_other_manager_available" : null,
      },
    }),
  );
}

export async function removeCaseMember(
  caseId: string,
  memberId: string,
  version: number,
  _values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId) || !isUuid(memberId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/cases/{id}/members/{memberId}/remove", {
      params: { path: { id: caseId, memberId } },
      body: { expectedVersion: version },
    }),
  );
}

export async function moveCase(
  caseId: string,
  version: number,
  to: "investigation" | "hearing" | "outcome" | "appeal" | "closed",
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId)) return bad();
  const on = req(values, "on");
  const body =
    to === "outcome"
      ? {
          to,
          on,
          expectedVersion: version,
          outcome: req(values, "outcome") as never,
          warningExpiresOn: str(values, "warningExpiresOn"),
          appealRightGiven: bool(values, "appealRightGiven"),
          noHearingReason: bool(values, "noHearing")
            ? ("employee_repeatedly_did_not_attend" as const)
            : null,
        }
      : to === "appeal"
        ? { to, on, expectedVersion: version, grounds: req(values, "grounds") }
        : to === "closed"
          ? {
              to,
              on,
              expectedVersion: version,
              reason: req(values, "reason") as never,
              appealOutcome: (str(values, "appealOutcome") ?? null) as never,
            }
          : { to, on, expectedVersion: version };
  return send((api) =>
    api.POST("/v1/workforce/cases/{id}/move", {
      params: { path: { id: caseId } },
      body: body as never,
    }),
  );
}

/** The appeal chair decides the appeal as the case closes (rule 15). */
export async function decideAppeal(
  caseId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  return moveCase(caseId, version, "closed", { ...values, reason: "appeal_decided" });
}

export async function arrangeHearing(
  caseId: string,
  kind: string,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId)) return bad();
  const date = req(values, "scheduledOn");
  const time = str(values, "scheduledTime") ?? "";
  if (!TIME.test(time)) {
    return refused(t("workforce.cases.hearing.timeRequired"), "invalid", ["scheduledTime"]);
  }
  return send((api) =>
    api.POST("/v1/workforce/cases/{id}/hearings", {
      params: { path: { id: caseId } },
      body: {
        kind: kind as never,
        ledBy: req(values, "ledBy"),
        invitedOn: req(values, "invitedOn"),
        scheduledAt: ukInstant(date, time),
        issueSetOut: bool(values, "issueSetOut"),
        evidenceShared: bool(values, "evidenceShared"),
        companionRightGiven: bool(values, "companionRightGiven"),
      },
    }),
  );
}

export async function updateHearing(
  caseId: string,
  hearingId: string,
  version: number,
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId) || !isUuid(hearingId)) return bad();
  const state = req(values, "state");
  return send((api) =>
    api.PATCH("/v1/workforce/cases/{id}/hearings/{hearingId}", {
      params: { path: { id: caseId, hearingId } },
      body: {
        expectedVersion: version,
        state: state as never,
        heldOn: state === "held" ? str(values, "heldOn") : null,
        accompanied: state === "held" ? bool(values, "accompanied") : null,
        postponedReason: state === "postponed" ? (str(values, "postponedReason") as never) : null,
      },
    }),
  );
}

export async function changeSuspension(
  caseId: string,
  version: number,
  kind: "start" | "review" | "end",
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId)) return bad();
  return send((api) =>
    api.PUT("/v1/workforce/cases/{id}/suspension", {
      params: { path: { id: caseId } },
      body: {
        expectedVersion: version,
        kind,
        on: req(values, "on"),
        reviewOn: str(values, "reviewOn"),
      },
    }),
  );
}

export async function recordReferral(
  caseId: string,
  version: number,
  body: "dbs" | "regulator",
  values: Values,
): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId)) return bad();
  const referred = req(values, "decision") === "referred";
  return send((api) =>
    api.PUT("/v1/workforce/cases/{id}/referrals", {
      params: { path: { id: caseId } },
      body: {
        expectedVersion: version,
        body,
        decision: referred ? "referred" : "not_required",
        referredOn: referred ? str(values, "referredOn") : null,
        reason: referred ? null : (str(values, "reason") as never),
      },
    }),
  );
}

export async function addCaseNote(caseId: string, values: Values): Promise<ActionResult<unknown>> {
  if (!isUuid(caseId)) return bad();
  return send((api) =>
    api.POST("/v1/workforce/cases/{id}/notes", {
      params: { path: { id: caseId } },
      body: { body: req(values, "body"), occurredOn: req(values, "occurredOn") },
    }),
  );
}

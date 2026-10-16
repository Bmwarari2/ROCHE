import type { ProblemDetails } from "@harbour/contracts";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** RFC 9457 problem details. Messages are plain English and never blame the user (section 8). */
export class HttpProblem extends Error {
  /** For a 429: how long to wait, sent as Retry-After. */
  retryAfterSeconds?: number;

  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(title);
    this.name = "HttpProblem";
  }
}

export const problems = {
  unauthenticated: () => new HttpProblem(401, "unauthenticated", "Please sign in to continue."),
  tenantRequired: () =>
    new HttpProblem(400, "tenant_required", "Choose an organisation to continue."),
  notAMember: () =>
    new HttpProblem(403, "not_a_member", "You do not have access to this organisation."),
  forbidden: () =>
    new HttpProblem(
      403,
      "missing_permission",
      "You do not have access to this. Ask your manager if you need it.",
    ),
  stepUp: () =>
    new HttpProblem(403, "step_up_required", "Please confirm it is you before continuing."),
  mfaRequired: () =>
    new HttpProblem(
      403,
      "mfa_enrolment_required",
      "Set up an authenticator app or a passkey before you open care records.",
    ),
  // MFA is enrolled but this session did not use it (#43 review M5, ADR-0072).
  mfaVerify: () =>
    new HttpProblem(
      403,
      "mfa_verification_required",
      "Sign in again with your passkey or authenticator app before you open care records.",
    ),
  featureDisabled: (detail?: string) =>
    new HttpProblem(403, "feature_disabled", "This is switched off for your organisation.", detail),
  notFound: () => new HttpProblem(404, "not_found", "We could not find that."),
  /**
   * The device was revoked by a manager (care.md section 6, Device integrity part 2): distinct from
   * an expired session (401) and from the session codes, so the device wipes, keeping unsent
   * entries under the hold rules.
   */
  deviceRevoked: () =>
    new HttpProblem(
      403,
      "device_revoked",
      "This device has been withdrawn from Harbour by a manager.",
      "Care records leave the device. Entries not yet sent stay on it, protected, until they are handed over or deleted.",
    ),
  conflict: (detail?: string) =>
    new HttpProblem(
      409,
      "version_conflict",
      "Someone else changed this record. Review their change first.",
      detail,
    ),
  /**
   * A create sent again with a client id already saved, but with other details (#26 review rounds
   * 2 and 3; HZ-029, HZ-015): nothing was changed. Its own code, so a screen says that what was
   * saved stands and the change must be made again after reloading, never that someone else
   * changed the record.
   */
  alreadySavedDifferently: (detail?: string) =>
    new HttpProblem(
      409,
      "already_saved_differently",
      "This was already saved with different details.",
      detail,
    ),
  invalid: (detail?: string) =>
    new HttpProblem(422, "invalid", "Some details need checking.", detail),
  /**
   * A hand-over of held entries the server will not take as sent (care.md section 6, Device
   * integrity part 6): the device stops and keeps the entry held, never parking it as refused.
   */
  handoverRefused: (detail: string) =>
    new HttpProblem(
      422,
      "handover_refused",
      "This entry cannot be sent for that member of staff from this device.",
      detail,
    ),
  /** A revocation asked for without confirming the entries the device last reported waiting. */
  entriesWaiting: (count: number) =>
    new HttpProblem(
      409,
      "entries_waiting",
      "This device last reported entries that have not reached Harbour.",
      `${count} ${count === 1 ? "entry is" : "entries are"} waiting on it. Confirm to withdraw it anyway: they stay on the device until handed over or deleted, and its task is due at once.`,
    ),
  /**
   * A sign-out asked for without confirming the entries the member's devices last reported waiting
   * (#40 review M2): the phone loses its care record until they sign in again.
   */
  memberEntriesWaiting: (count: number) =>
    new HttpProblem(
      409,
      "entries_waiting",
      "This person's phone has care entries that have not reached Harbour.",
      `${count} ${count === 1 ? "entry is" : "entries are"} waiting. Signing them out also removes the care record from their phone until they sign in again. The entries not yet sent stay on the phone, protected, until then. Confirm to sign them out anyway.`,
    ),
  /**
   * Sessions belong to the person's sign-in, not to one organisation (#40 review M1): signing out
   * someone who also works for another organisation would end their work there too.
   */
  memberOfAnotherOrganisation: () =>
    new HttpProblem(
      409,
      "member_of_other_organisation",
      "This person also works for another organisation in Harbour.",
      "Signing them out here would sign them out there too, so they have not been signed out. Ask them to sign out of their own devices, or contact Harbour support.",
    ),
};

export function problemResponse(c: Context, problem: HttpProblem, requestId?: string) {
  const body: ProblemDetails = {
    type: "about:blank",
    title: problem.title,
    status: problem.status,
    code: problem.code,
    ...(problem.detail ? { detail: problem.detail } : {}),
    ...(requestId ? { requestId } : {}),
  };
  return c.json(body, problem.status, {
    "content-type": "application/problem+json",
    ...(problem.retryAfterSeconds ? { "retry-after": String(problem.retryAfterSeconds) } : {}),
  });
}

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
  featureDisabled: (detail?: string) =>
    new HttpProblem(403, "feature_disabled", "This is switched off for your organisation.", detail),
  notFound: () => new HttpProblem(404, "not_found", "We could not find that."),
  conflict: (detail?: string) =>
    new HttpProblem(
      409,
      "version_conflict",
      "Someone else changed this record. Review their change first.",
      detail,
    ),
  invalid: (detail?: string) =>
    new HttpProblem(422, "invalid", "Some details need checking.", detail),
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

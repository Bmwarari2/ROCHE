import { InvitationSent } from "@harbour/contracts";
import { createRoute, z } from "@hono/zod-openapi";
import { stepUpFreshAt } from "../auth/session-factor";
import { HttpProblem, problems } from "../http/problem";
import { audit, newInvitationToken, sendInvitationEmail } from "../services/invitations";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
  unavailableResponse,
} from "./openapi";

/**
 * The first owner's invitation (platform.md, Invitations step 1): an operator admin, with a fresh
 * sign-in, invites the invited owner of an organisation with no active member, through
 * `app.invite_first_owner`, which checks the operator (`app.operator_id`, set here for the
 * transaction), supersedes any open invitation and audits in the organisation's chain. Operators
 * have no other way to write an invitation.
 */

const REFUSED: Record<string, HttpProblem> = {
  operator_not_admin: problems.forbidden(),
  organisation_not_active: new HttpProblem(
    409,
    "organisation_not_active",
    "The organisation is not onboarding or active.",
  ),
  organisation_has_members: new HttpProblem(
    409,
    "organisation_has_members",
    "The organisation already has an active member, who invites the rest.",
  ),
  no_invited_owner: new HttpProblem(
    409,
    "no_invited_owner",
    "The organisation has no invited owner.",
  ),
  invitation_expiry_not_set: new HttpProblem(
    503,
    "invitation_expiry_not_set",
    "The invitation expiry is missing from the rate table.",
  ),
};

export const operatorInvitationsRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/operator/tenants/{tenantId}/owner-invitation",
    tags: ["operator"],
    summary: "Invite an organisation's first owner (admins, fresh sign-in)",
    security,
    request: { params: z.object({ tenantId: z.uuid() }) },
    responses: {
      201: jsonBody(InvitationSent, "Sent"),
      ...errorResponses,
      ...notFoundResponse,
      ...conflictResponse,
      ...unavailableResponse,
    },
  }),
  async (c) => {
    const operator = c.get("operator");
    const services = c.get("services");
    const requestId = c.get("requestId");
    const { tenantId } = c.req.valid("param");
    // Step-up counts from the second factor this session last used, never a password sign-in.
    const fresh = stepUpFreshAt(
      operator.factorAt,
      new Date(),
      services.config.STEP_UP_WINDOW_SECONDS,
    );
    if (operator.role !== "admin" || !fresh) {
      throw operator.role !== "admin" ? problems.forbidden() : problems.stepUp();
    }
    const { token, hash } = newInvitationToken();
    const client = await services.operatorPool.connect();
    let sent: { invitation_id: string; email: string; expires_at: Date } | undefined;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.operator_id', $1, true), set_config('app.tenant_id', $2, true)",
        [operator.id, tenantId],
      );
      const exists = await client.query("SELECT 1 FROM tenant WHERE id = $1", [tenantId]);
      if ((exists.rowCount ?? 0) === 0) throw problems.notFound();
      const result = await client.query<{ invitation_id: string; email: string; expires_at: Date }>(
        "SELECT invitation_id, email, expires_at FROM app.invite_first_owner($1, $2)",
        [tenantId, hash],
      );
      sent = result.rows[0];
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      const refused = REFUSED[(error as { message?: string }).message ?? ""];
      if (!refused) throw error;
      await audit(services.appPool, tenantId, {
        action: "platform.invitation.sent",
        outcome: "denied",
        reason: refused.code,
        actorAuthUserId: operator.authUserId,
        actorRoleKeys: [`thapsus_${operator.role}`],
        scope: { operatorId: operator.id, firstOwner: true },
        requestId,
      });
      throw refused;
    } finally {
      client.release();
    }
    if (!sent) throw new Error("owner invitation not stored");
    const emailSent = await sendInvitationEmail(
      {
        db: services.db,
        appPool: services.appPool,
        webOrigin: services.config.webOrigins[0] ?? services.config.BETTER_AUTH_URL,
        adapterFor: services.adapterFor,
      },
      { id: sent.invitation_id, tenantId, email: sent.email },
      token,
      { actorAuthUserId: operator.authUserId, requestId },
    );
    return c.json(
      { id: sent.invitation_id, expiresAt: new Date(sent.expires_at).toISOString(), emailSent },
      201,
    );
  },
);

import { DEVICE_HEADER, DeviceKeyOut, EnrolDeviceKey } from "@harbour/contracts";
import { memberDeviceKey } from "@harbour/db";
import { createRoute } from "@hono/zod-openapi";
import { AuditedRefusal, auditInTx, withAuditedRefusal } from "../http/audit";
import { deviceIdOf, requireAnyPermission, stepUpFresh, withTenant } from "../http/context";
import { type HttpProblem, problems } from "../http/problem";
import { bindingOf } from "../services/devices";
import { createRouter, errorResponses, jsonBody, security } from "./openapi";

/**
 * A member's signing key for the phone in their hand (ADR-0084; Phase 2 slice 70): the phone makes
 * an ECDSA P-256 key when the member sets their medicines PIN, wraps the private half with the PIN
 * and sends the public half here, online, after a fresh step-up. With it, the member signs a
 * controlled drug's dose on that phone offline, as its recorder or its witness, and the API
 * verifies the signature when the dose arrives. Only on a phone bound to the member and not
 * revoked; a new PIN is a new key, and only the newest signs from then. Audited.
 */
export const deviceKeysRouter = createRouter().openapi(
  createRoute({
    method: "post",
    path: "/v1/me/device-keys",
    tags: ["medicines"],
    summary: "Enrol your signing key for this phone",
    description:
      "For holders of medicines.cd.administer or medicines.cd.witness, with a fresh step-up, from a phone bound to them (x-harbour-device) and not revoked. Stores the public key; the newest key for the member and phone signs from its enrolment. Audited as medicines.device_key.enrolled.",
    security,
    request: {
      body: { content: { "application/json": { schema: EnrolDeviceKey } }, required: true },
    },
    responses: { 201: jsonBody(DeviceKeyOut, "The key enrolled"), ...errorResponses },
  }),
  async (c) => {
    const access = await requireAnyPermission(c, [
      "medicines.cd.administer",
      "medicines.cd.witness",
    ]);
    const body = c.req.valid("json");
    const deviceId = deviceIdOf(c.req.header(DEVICE_HEADER));
    const out = await withAuditedRefusal(c, access, () =>
      withTenant(c, async (tx) => {
        const refuse = (problem: string, response: HttpProblem) =>
          new AuditedRefusal(response, {
            action: "medicines.device_key.enrolled",
            outcome: "denied",
            resourceType: "member_device_key",
            resourceId: deviceId ?? undefined,
            scope: { problems: [problem] },
          });
        if (!stepUpFresh(access)) throw refuse("step_up_required", problems.stepUp());
        if (!deviceId) {
          throw refuse(
            "device_required",
            problems.invalid("Set your medicines PIN on the phone you will use it on."),
          );
        }
        const binding = await bindingOf(tx, deviceId, access.tenantUserId);
        if (!binding || binding.revokedAt) {
          throw refuse(
            "device_not_bound",
            problems.invalid(
              "This phone is not one you have synced on, or its access was withdrawn. Sync on it first.",
            ),
          );
        }
        const [row] = await tx
          .insert(memberDeviceKey)
          .values({ deviceId, tenantUserId: access.tenantUserId, publicKey: body.publicKey })
          .returning();
        const key = row as typeof memberDeviceKey.$inferSelect;
        await auditInTx(tx, access, {
          action: "medicines.device_key.enrolled",
          resourceType: "member_device_key",
          resourceId: key.id,
          scope: { deviceId },
          requestId: c.get("requestId"),
        });
        return { id: key.id, deviceId, enrolledAt: key.enrolledAt.toISOString() };
      }),
    );
    return c.json(out, 201);
  },
);

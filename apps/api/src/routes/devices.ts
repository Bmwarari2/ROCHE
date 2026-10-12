import { DeviceBindingList, RevokeDevice, RevokeDeviceResult } from "@harbour/contracts";
import { createRoute, z } from "@hono/zod-openapi";
import { requirePermission } from "../http/context";
import { problems } from "../http/problem";
import { listDevices, revokeDevice } from "../services/devices";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * Care mode devices (care.md section 6, Device integrity part 2; platform.md): the devices staff
 * have used, and a manager's revocation of a lost or withdrawn one. A revoked device is refused
 * with 403 `device_revoked` at its next sync token or upload, and wipes, keeping unsent entries
 * under the hold rules.
 */
export const devicesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/devices",
      tags: ["platform"],
      summary: "Care mode devices staff have used, and whether each is revoked",
      description:
        "Lists device bindings: the device, the member of staff, when the server first and last saw them together, and any revocation. A location role sees only devices used by staff whose live, or else most recent, role assignment is at one of its locations.",
      security,
      request: { query: z.object({ tenantUserId: z.uuid().optional() }) },
      responses: { 200: jsonBody(DeviceBindingList, "Devices"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.device.read");
      const { tenantUserId } = c.req.valid("query");
      const items = await listDevices(c.get("services").db, access, { tenantUserId }, new Date());
      return c.json({ items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/v1/devices/{deviceId}/revoke",
      tags: ["platform"],
      summary: "Revoke a lost or withdrawn Care mode device",
      description:
        "Marks every binding of the device revoked with a coded reason (step-up). At its next sync token or upload the device is refused with 403 device_revoked and wipes, keeping entries not yet sent under the hold rules. A device already revoked changes nothing. A device no member the caller manages has used reads as not found.",
      security,
      request: {
        params: z.object({ deviceId: z.uuid() }),
        body: { content: { "application/json": { schema: RevokeDevice } } },
      },
      responses: {
        200: jsonBody(RevokeDeviceResult, "Revoked (or already revoked)"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.device.revoke");
      const { deviceId } = c.req.valid("param");
      const { reasonCode } = c.req.valid("json");
      const result = await revokeDevice(c.get("services").db, access, {
        deviceId: deviceId.toLowerCase(),
        reasonCode,
        now: new Date(),
        requestId: c.get("requestId"),
      });
      if (!result) throw problems.notFound();
      return c.json(
        {
          deviceId: deviceId.toLowerCase(),
          revokedAt: result.revokedAt.toISOString(),
          replay: result.replay,
          bindings: result.bindings,
        },
        200,
      );
    },
  );

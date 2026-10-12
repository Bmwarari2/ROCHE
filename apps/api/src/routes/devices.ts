import { DeviceBindingList, RevokeDevice, RevokeDeviceResult } from "@harbour/contracts";
import { createRoute, z } from "@hono/zod-openapi";
import { requirePermission } from "../http/context";
import { problems } from "../http/problem";
import { hurryRevokedHold, lastReportedWaiting } from "../services/device-holds";
import { inSystemView, listDevices, revokeDevice } from "../services/devices";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * Care mode devices (care.md section 6, Device integrity part 2; platform.md): the devices staff
 * have used, with the entries each last reported waiting, and a manager's revocation of a lost or
 * withdrawn one. A revoked device is refused with 403 `device_revoked` at its next sync token or
 * upload, as is every request from a session bound to it except its report (its sessions are not
 * ended, so the device can tell a revocation from a lapsed sign-in), and wipes, keeping unsent
 * entries under the hold rules.
 */
export const devicesRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/devices",
      tags: ["platform"],
      summary: "Care mode devices staff have used, and whether each is revoked",
      description:
        "Lists device bindings: the device, the member of staff, when the server first and last saw them together, any revocation, and the entries the device last reported waiting and when. A location role sees only devices used by staff whose live, or else most recent, role assignment is at one of its locations.",
      security,
      request: { query: z.object({ tenantUserId: z.uuid().optional() }) },
      responses: { 200: jsonBody(DeviceBindingList, "Devices"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.device.read");
      const { tenantUserId } = c.req.valid("query");
      const { db } = c.get("services");
      const rows = await listDevices(db, access, { tenantUserId }, new Date());
      const waiting = await inSystemView(db, access, (tx) =>
        lastReportedWaiting(tx, [...new Set(rows.map((r) => r.deviceId))]),
      );
      const items = rows.map((r) => {
        const last = waiting.get(r.deviceId);
        return {
          ...r,
          entriesWaiting: last?.waiting ?? 0,
          lastReportedAt: last?.at.toISOString() ?? null,
        };
      });
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
        "Marks every binding of the device revoked with a coded reason (step-up). At its next sync token or upload the device is refused with 403 device_revoked and wipes, keeping entries not yet sent under the hold rules. The sessions bound to it are not ended: every request from one is refused with 403 device_revoked whatever device it names, except its device report, which may raise or hurry the hold's task but never close it. When the device last reported entries waiting, the revocation needs confirmEntriesWaiting (409 entries_waiting otherwise), and its hold's task falls due at once, urgent, with a notice to the manager. A device already revoked changes nothing but hurries that task again. A device no member the caller manages has used reads as not found; a location role may not revoke a device staff it does not manage have also used.",
      security,
      request: {
        params: z.object({ deviceId: z.uuid() }),
        body: { content: { "application/json": { schema: RevokeDevice } } },
      },
      responses: {
        200: jsonBody(RevokeDeviceResult, "Revoked (or already revoked)"),
        ...errorResponses,
        ...notFoundResponse,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, "platform.device.revoke");
      const { deviceId: param } = c.req.valid("param");
      const { reasonCode, confirmEntriesWaiting } = c.req.valid("json");
      const deviceId = param.toLowerCase();
      const services = c.get("services");
      const now = new Date();
      // The manager is told how many entries the device last reported waiting before it is
      // withdrawn: they stay on it until handed over or deleted (#25 review round 2, M4).
      const last = (
        await inSystemView(services.db, access, (tx) => lastReportedWaiting(tx, [deviceId]))
      ).get(deviceId);
      const waiting = last?.waiting ?? 0;
      const result = await revokeDevice(services.db, access, {
        deviceId,
        reasonCode,
        now,
        requestId: c.get("requestId"),
        unconfirmedWaiting: confirmEntriesWaiting === true ? 0 : waiting,
      });
      if (!result) throw problems.notFound();
      // The sessions bound to the device stay: the tenant middleware refuses them with
      // device_revoked, which the device reads as a revocation (#25 review round 3, M2). A replay
      // hurries the hold again, moving only what is not yet due and urgent (round 3, low).
      await hurryRevokedHold(services.db, access, {
        deviceId,
        waiting,
        now,
        requestId: c.get("requestId"),
      });
      return c.json(
        {
          deviceId,
          revokedAt: result.revokedAt.toISOString(),
          replay: result.replay,
          bindings: result.bindings,
          entriesWaiting: waiting,
          lastReportedAt: last?.at.toISOString() ?? null,
        },
        200,
      );
    },
  );

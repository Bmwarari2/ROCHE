import { DEVICE_HEADER } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Device integrity (care.md section 6; the follow-ups from the #15 reviews): device bindings,
 * revocation, deletion lists, one open sync task per source, copies of refused entries, the
 * hand-over of held entries and shared quotas. Test names carry the hazards they verify.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const DAY = 86_400_000;

/** A query as the table owner inside one tenant: row-level security is forced for the owner too. */
async function asTenant<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  tenantId: string = DEMO.tenantId,
): Promise<T[]> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId],
    );
    const result = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type Who = keyof Harness["tokens"];

/** A request from a member, in the demo organisation, from a device when one is named. */
const call = (
  who: Who,
  path: string,
  init: { method?: string; body?: unknown; device?: string; headers?: Record<string, string> } = {},
) =>
  h.request(path, {
    token: h.tokens[who],
    tenant: DEMO.tenantId,
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
    headers: { ...(init.device ? { [DEVICE_HEADER]: init.device } : {}), ...init.headers },
  });

const syncToken = (who: Who, device?: string) =>
  call(who, "/v1/sync/token", { method: "POST", ...(device ? { device } : {}) });

const report = (who: Who, body: Record<string, unknown>, device: string) =>
  call(who, "/v1/sync/device-report", {
    method: "POST",
    device,
    body: {
      unsent: 0,
      refused: 0,
      held: 0,
      blocked: 0,
      oldestAgeSeconds: null,
      reportedAt: new Date().toISOString(),
      ...body,
    },
  });

const bindings = (device: string) =>
  asTenant<{ tenant_user_id: string; first_seen_at: Date; last_seen_at: Date }>(
    "SELECT tenant_user_id, first_seen_at, last_seen_at FROM device_binding WHERE device_id = $1 ORDER BY tenant_user_id",
    [device],
  );

const reportScopes = (device: string) =>
  asTenant<{ scope: Record<string, unknown> }>(
    "SELECT scope FROM audit_event WHERE action = 'sync.device.report' AND resource_type = 'device' AND resource_id = $1 ORDER BY seq",
    [device],
  ).then((rows) => rows.map((r) => r.scope));

describe("part 1: device bindings", () => {
  it("hazard HZ-040 binds the member to the device at each sync token, first seen kept and last seen moved on", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0001";
    expect((await syncToken("carer", device)).status).toBe(200);
    const [first] = await bindings(device);
    expect(first?.tenant_user_id).toBe(DEMO.users.carer.id);
    expect((await syncToken("carer", device)).status).toBe(200);
    const [again] = await bindings(device);
    expect(again?.first_seen_at).toEqual(first?.first_seen_at);
    expect(again?.last_seen_at.getTime()).toBeGreaterThanOrEqual(
      first?.last_seen_at.getTime() ?? 0,
    );
    // A token asked for without a device binds nothing.
    const before = await asTenant<{ n: string }>("SELECT count(*) AS n FROM device_binding");
    expect((await syncToken("manager")).status).toBe(200);
    expect(await asTenant<{ n: string }>("SELECT count(*) AS n FROM device_binding")).toEqual(
      before,
    );
  });

  it("hazard HZ-040 binds a reporter by their report, judged after it (security review round 7, M1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0002";
    await report("carer", { held: 1 }, device);
    await report("carer", { held: 1 }, device);
    const scopes = await reportScopes(device);
    expect(scopes.map((s) => s.ownerBound)).toEqual([false, true]);
    expect((await bindings(device)).map((b) => b.tenant_user_id)).toEqual([DEMO.users.carer.id]);
  });

  it("hazard HZ-040 takes the owner as bound from device_binding, never from an audit event (security review round 7, M1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0003";
    // An event from the device in the manager's name is not a binding.
    await asTenant(
      `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, actor_tenant_user_id, device_id)
       VALUES ($1, 'sync.token.issue', 'device', $2, $3, $2)`,
      [DEMO.tenantId, device, DEMO.users.manager.id],
    );
    await report("carer", { held: 1, ownerTenantUserId: DEMO.users.manager.id }, device);
    expect((await reportScopes(device))[0]).toMatchObject({
      ownerBound: false,
      ownerTenantUserId: DEMO.users.carer.id,
      claimedOwnerTenantUserId: DEMO.users.manager.id,
    });
    // The manager's own sync token on the device binds them.
    expect((await syncToken("manager", device)).status).toBe(200);
    await report("carer", { held: 1, ownerTenantUserId: DEMO.users.manager.id }, device);
    expect((await reportScopes(device))[1]).toMatchObject({
      ownerBound: true,
      ownerTenantUserId: DEMO.users.manager.id,
    });
  });

  it("hazard HZ-010 never takes a hold's start earlier than the device's earliest binding", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0004";
    await asTenant(
      `INSERT INTO device_binding (tenant_id, device_id, tenant_user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days')`,
      [DEMO.tenantId, device, DEMO.users.carer.id],
    );
    const backdated = new Date(Date.now() - 20 * DAY).toISOString();
    await report("carer", { held: 1, heldSince: backdated }, device);
    const [scope] = await reportScopes(device);
    expect(scope?.startFloor).toBe("first_seen");
    const since = new Date(String(scope?.waitingSince)).getTime();
    expect(Math.abs(since - (Date.now() - 2 * DAY))).toBeLessThan(60_000);
  });

  it("hazard HZ-011 keeps a binding in its own organisation", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0005";
    expect(
      (
        await h.request("/v1/sync/token", {
          token: h.tokens.rae,
          tenant: OTHER.tenantId,
          method: "POST",
          headers: { [DEVICE_HEADER]: device },
        })
      ).status,
    ).toBe(200);
    expect(await bindings(device)).toEqual([]);
    expect(
      await asTenant("SELECT 1 FROM device_binding WHERE device_id = $1", [device], OTHER.tenantId),
    ).toHaveLength(1);
  });
});

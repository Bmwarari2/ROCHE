import { DEVICE_REVOCATION_REASONS as CONTRACT_REASONS, DEVICE_HEADER } from "@harbour/contracts";
import { DEVICE_REVOCATION_REASONS as TABLE_REASONS } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

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

const json = async <T>(response: Response) => (await response.json()) as T;
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
/** A UUIDv7-shaped id as a device would make it. */
const newId = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A note about the carer's first resident, from a device when one is named. */
const noteFrom = (
  who: Who,
  device: string | undefined,
  extra: Record<string, string> = {},
  id: string = newId(),
  person = 1,
) =>
  call(who, `/v1/people/${resident(person)}/notes`, {
    method: "POST",
    ...(device ? { device } : {}),
    headers: extra,
    body: {
      id,
      category: "personal_care",
      body: "Assisted with a wash; skin intact.",
      occurredAt: minutesAgo(5),
    },
  });
const noteWithId = (who: Who, id: string) => noteFrom(who, undefined, {}, id);

/** Moves a member's session sign-in back an hour, so a step-up permission needs a new sign-in. */
async function staleSignIn(who: Who, fn: () => Promise<void>) {
  const token = h.tokens[who]?.split(".")[0];
  const auth = h.db.pool("harbour_auth");
  await auth.query(
    "UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE token = $1",
    [token],
  );
  try {
    await fn();
  } finally {
    await auth.query("UPDATE auth.session SET created_at = now() WHERE token = $1", [token]);
  }
}

describe("part 2: revocation", () => {
  it("offers the same revocation reasons in the contract as the table takes", () => {
    expect([...CONTRACT_REASONS]).toEqual([...TABLE_REASONS]);
  });

  const revoke = (who: Who, device: string, reasonCode = "lost_or_stolen") =>
    call(who, `/v1/devices/${device}/revoke`, { method: "POST", body: { reasonCode } });
  const listed = async (who: Who, query = "") =>
    (
      await json<{ items: { deviceId: string; tenantUserId: string; revokedAt: string | null }[] }>(
        await call(who, `/v1/devices${query}`),
      )
    ).items;

  it("hazard HZ-011 lists the devices a manager's staff have used, and only theirs", async () => {
    const carers = "0199d000-0000-4000-8000-0000000b0201";
    const quality = "0199d000-0000-4000-8000-0000000b0202";
    await syncToken("carer", carers);
    await asTenant(
      "INSERT INTO device_binding (tenant_id, device_id, tenant_user_id) VALUES ($1, $2, $3)",
      [DEMO.tenantId, quality, LODGE.qualityLeadId],
    );
    // The Registered Manager reaches the carer at their home, not the organisation-wide quality lead.
    const managers = (await listed("manager")).map((d) => d.deviceId);
    expect(managers).toContain(carers);
    expect(managers).not.toContain(quality);
    // The owner reaches everyone; a member's list can be asked for alone.
    expect((await listed("owner")).map((d) => d.deviceId)).toEqual(
      expect.arrayContaining([carers, quality]),
    );
    expect(
      (await listed("owner", `?tenantUserId=${DEMO.users.carer.id}`)).every(
        (d) => d.tenantUserId === DEMO.users.carer.id,
      ),
    ).toBe(true);
    // A care worker may not list devices; another organisation sees none of these.
    expect((await call("carer", "/v1/devices")).status).toBe(403);
    const other = await h.request("/v1/devices", { token: h.tokens.rae, tenant: OTHER.tenantId });
    expect(other.status).toBe(403);
  });

  it("hazard HZ-040 revokes a device with a coded reason after a fresh sign-in, audited; a second revocation changes nothing", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0203";
    await syncToken("carer", device);
    await staleSignIn("manager", async () => {
      const refused = await revoke("manager", device);
      expect(refused.status).toBe(403);
      expect((await json<{ code: string }>(refused)).code).toBe("step_up_required");
    });
    const first = await revoke("manager", device, "staff_left");
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({ deviceId: device, replay: false, bindings: 1 });
    const again = await json<{ replay: boolean }>(await revoke("manager", device));
    expect(again.replay).toBe(true);
    const audit = await asTenant<{ actor: string; reason: string; scope: Record<string, unknown> }>(
      "SELECT actor_tenant_user_id AS actor, reason, scope FROM audit_event WHERE action = 'platform.device.revoked' AND resource_id = $1",
      [device],
    );
    expect(audit).toEqual([
      {
        actor: DEMO.users.manager.id,
        reason: "staff_left",
        scope: { reasonCode: "staff_left", bindings: 1, memberIds: [DEMO.users.carer.id] },
      },
    ]);
    // An unknown reason is refused, and a care worker may not revoke.
    expect((await revoke("manager", device, "because")).status).toBe(422);
    expect((await revoke("carer", device)).status).toBe(403);
  });

  it("hazard HZ-011 reads a device no member the manager manages has used as not found", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0204";
    await asTenant(
      "INSERT INTO device_binding (tenant_id, device_id, tenant_user_id) VALUES ($1, $2, $3)",
      [DEMO.tenantId, device, LODGE.qualityLeadId],
    );
    expect((await revoke("manager", device)).status).toBe(404);
    expect((await revoke("manager", "0199d000-0000-4000-8000-0000000b02ff")).status).toBe(404);
    expect((await revoke("owner", device)).status).toBe(200);
  });

  it("hazard HZ-006 tells a revoked device apart from an expired session: 403 device_revoked on the token and uploads, audited", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0205";
    expect((await syncToken("carer", device)).status).toBe(200);
    expect((await noteFrom("carer", device)).status).toBe(201);
    expect((await revoke("manager", device)).status).toBe(200);
    for (const response of [
      await syncToken("carer", device),
      // Someone else signing in on the device is refused too: the device is revoked, not a member.
      await syncToken("owner", device),
      await call("carer", "/v1/sync/upload", {
        method: "POST",
        device,
        body: { operations: [] },
      }),
      await noteFrom("carer", device),
    ]) {
      expect(response.status).toBe(403);
      expect((await json<{ code: string }>(response)).code).toBe("device_revoked");
    }
    const refusals = await asTenant<{ route: string }>(
      "SELECT scope ->> 'route' AS route FROM audit_event WHERE action = 'sync.device.refused_revoked' AND resource_id = $1 ORDER BY seq",
      [device],
    );
    expect(refusals.map((r) => r.route)).toEqual([
      "sync.token",
      "sync.token",
      "sync.upload",
      "care.care_note",
    ]);
    // The member's session stands: from another device, or none, the same requests work.
    expect((await syncToken("carer")).status).toBe(200);
    expect((await noteFrom("carer", undefined)).status).toBe(201);
    // The server still hears what the revoked device holds.
    expect((await report("carer", { held: 1 }, device)).status).toBe(204);
  });
});

const discard = (
  who: Who,
  body: { id: string; stage: string; entryIds: string[]; owner: string },
  device?: string,
) =>
  call(who, "/v1/sync/discards", {
    method: "POST",
    ...(device ? { device } : {}),
    body: {
      id: body.id,
      kind: "held_deleted",
      stage: body.stage,
      reasonCode: "recorded_elsewhere",
      ownerTenantUserId: body.owner,
      deletedByTenantUserId: body.owner,
      entryIds: body.entryIds,
      personIds: [resident(1)],
      count: body.entryIds.length,
      discardedAt: new Date().toISOString(),
    },
  });

describe("part 3: deletion lists", () => {
  const flagged = (entryId: string) =>
    asTenant<{ scope: Record<string, unknown> }>(
      "SELECT scope FROM audit_event WHERE action = 'sync.entry.after_discard' AND resource_id = $1",
      [entryId],
    );

  it("hazard HZ-040 lists each stage's entry ids with the deletion record", async () => {
    const id = crypto.randomUUID();
    const entries = [newId(), newId()];
    for (const stage of ["requested", "deleted"]) {
      expect(
        (await discard("carer", { id, stage, entryIds: entries, owner: DEMO.users.carer.id }))
          .status,
      ).toBe(200);
    }
    const rows = await asTenant<{ stage: string; entry_id: string; owner: string }>(
      "SELECT stage, entry_id, owner_tenant_user_id AS owner FROM device_discard_entry WHERE discard_id = $1 ORDER BY stage, entry_id",
      [id],
    );
    expect(rows).toEqual(
      ["deleted", "requested"].flatMap((stage) =>
        [...entries].sort().map((entry_id) => ({ stage, entry_id, owner: DEMO.users.carer.id })),
      ),
    );
    // A replayed stage lists nothing twice.
    await discard("carer", { id, stage: "deleted", entryIds: entries, owner: DEMO.users.carer.id });
    expect(
      await asTenant("SELECT 1 FROM device_discard_entry WHERE discard_id = $1", [id]),
    ).toHaveLength(4);
  });

  it("hazard HZ-040 finds an uploaded entry's deletion in device_discard_entry, never by reading the audit trail", async () => {
    // A deletion in the audit trail with no list (as if written before the table) flags nothing.
    const unlisted = newId();
    await asTenant(
      `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, scope)
       VALUES ($1, 'sync.entries.discarded', 'device_discard', $2,
               jsonb_build_object('ownerTenantUserId', $3::text, 'entryIds', jsonb_build_array($4::text)))`,
      [DEMO.tenantId, crypto.randomUUID(), DEMO.users.carer.id, unlisted],
    );
    expect((await noteWithId("carer", unlisted)).status).toBe(201);
    expect(await flagged(unlisted)).toEqual([]);
    // Listed by a recorded deletion: kept and flagged, naming the record.
    const listedEntry = newId();
    const id = crypto.randomUUID();
    for (const stage of ["requested", "deleted"]) {
      await discard("carer", { id, stage, entryIds: [listedEntry], owner: DEMO.users.carer.id });
    }
    expect((await noteWithId("carer", listedEntry)).status).toBe(201);
    expect((await flagged(listedEntry)).map((r) => r.scope.discardId)).toEqual([id]);
  });

  it("hazard HZ-040 does not flag an entry whose deletion failed, nor someone else's deletion", async () => {
    const failedEntry = newId();
    const failed = crypto.randomUUID();
    for (const stage of ["requested", "deleted", "failed"]) {
      await discard("carer", {
        id: failed,
        stage,
        entryIds: [failedEntry],
        owner: DEMO.users.carer.id,
      });
    }
    expect((await noteWithId("carer", failedEntry)).status).toBe(201);
    expect(await flagged(failedEntry)).toEqual([]);
    const theirs = newId();
    const record = crypto.randomUUID();
    for (const stage of ["requested", "deleted"]) {
      await discard("manager", {
        id: record,
        stage,
        entryIds: [theirs],
        owner: DEMO.users.manager.id,
      });
    }
    expect((await noteWithId("carer", theirs)).status).toBe(201);
    expect(await flagged(theirs)).toEqual([]);
  });
});

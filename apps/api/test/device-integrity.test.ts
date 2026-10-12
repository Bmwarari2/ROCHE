import {
  DEVICE_REVOCATION_REASONS as CONTRACT_REASONS,
  DEVICE_HEADER,
  HANDOVER_ID_HEADER,
  HANDOVER_OWNER_HEADER,
  TENANT_HEADER,
} from "@harbour/contracts";
import { DEVICE_REVOCATION_REASONS as TABLE_REASONS } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createLogger } from "../src/logger";
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
/** A member's harness sign-in, or a session made for one test (`freshSession`). */
type As = Who | { readonly token: string };
const tokenOf = (as: As) => (typeof as === "string" ? h.tokens[as] : as.token);

/**
 * A new sign-in for the member, a session of its own (the bearer plugin takes the session token as
 * it is): a revoked device's sessions are refused everything but its report, so a test that
 * revokes one binds only sessions it made.
 */
async function freshSession(who: Who): Promise<{ token: string; id: string }> {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replace(/-/g, "");
  await h.db.pool("harbour_auth").query(
    `INSERT INTO auth.session (id, token, user_id, expires_at, created_at, updated_at)
     SELECT $1, $2, user_id, now() + interval '1 day', now(), now() FROM auth.session WHERE token = $3`,
    [id, token, h.tokens[who]?.split(".")[0]],
  );
  return { token, id };
}

/** Moves a session's sign-in back an hour while `fn` runs, so a step-up needs a new sign-in. */
async function staleSession(id: string, fn: () => Promise<void>) {
  const auth = h.db.pool("harbour_auth");
  await auth.query("UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE id = $1", [
    id,
  ]);
  try {
    await fn();
  } finally {
    await auth.query("UPDATE auth.session SET created_at = now() WHERE id = $1", [id]);
  }
}

/** A request from a member, in the demo organisation, from a device when one is named. */
const call = (
  who: As,
  path: string,
  init: { method?: string; body?: unknown; device?: string; headers?: Record<string, string> } = {},
) =>
  h.request(path, {
    token: tokenOf(who),
    tenant: DEMO.tenantId,
    ...(init.method ? { method: init.method } : {}),
    ...(init.body !== undefined ? { body: init.body } : {}),
    headers: { ...(init.device ? { [DEVICE_HEADER]: init.device } : {}), ...init.headers },
  });

const syncToken = (who: As, device?: string) =>
  call(who, "/v1/sync/token", { method: "POST", ...(device ? { device } : {}) });

const report = (who: As, body: Record<string, unknown>, device: string) =>
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
  who: As,
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
/** A note with its event time and, when given, when it was written on the device. */
const noteAt = (
  who: As,
  device: string,
  headers: Record<string, string>,
  times: { readonly occurredAt: string; readonly deviceTime?: string },
  person = 1,
  id: string = newId(),
) =>
  call(who, `/v1/people/${resident(person)}/notes`, {
    method: "POST",
    device,
    headers,
    body: { id, category: "personal_care", body: "Assisted with a wash; skin intact.", ...times },
  });

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

  const revoke = (who: As, device: string, reasonCode = "lost_or_stolen", confirm?: boolean) =>
    call(who, `/v1/devices/${device}/revoke`, {
      method: "POST",
      body: { reasonCode, ...(confirm === undefined ? {} : { confirmEntriesWaiting: confirm }) },
    });
  const listed = async (who: As, query = "") =>
    (
      await json<{
        items: {
          deviceId: string;
          tenantUserId: string;
          revokedAt: string | null;
          entriesWaiting: number;
          lastReportedAt: string | null;
        }[];
      }>(await call(who, `/v1/devices${query}`))
    ).items;

  it("hazard HZ-011 lists the devices a manager's staff have used, and only theirs, with the entries each last reported waiting", async () => {
    const carers = "0199d000-0000-4000-8000-0000000b0201";
    const quality = "0199d000-0000-4000-8000-0000000b0202";
    await syncToken("carer", carers);
    await report("carer", { held: 2 }, carers);
    await asTenant(
      "INSERT INTO device_binding (tenant_id, device_id, tenant_user_id) VALUES ($1, $2, $3)",
      [DEMO.tenantId, quality, LODGE.qualityLeadId],
    );
    // The Registered Manager reaches the carer at their home, not the organisation-wide quality lead.
    const managers = await listed("manager");
    expect(managers.map((d) => d.deviceId)).toContain(carers);
    expect(managers.map((d) => d.deviceId)).not.toContain(quality);
    expect(managers.find((d) => d.deviceId === carers)?.entriesWaiting).toBe(2);
    expect(managers.find((d) => d.deviceId === carers)?.lastReportedAt).toEqual(expect.any(String));
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

  it("hazard HZ-040 revokes a device with a coded reason after a fresh sign-in, once told what it holds: audited, its task due at once and whoever revoked it told; a second revocation changes nothing more", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0203";
    // The owner raises no other hold before this in the file, so the hold has the device's own
    // tasks; they revoke it from another sign-in, one the device never used.
    const user = await freshSession("owner");
    const revoker = await freshSession("owner");
    await syncToken(user, device);
    expect((await report(user, { held: 1 }, device)).status).toBe(204);
    const holdTasks = () =>
      asTenant<{ id: string; status: string; priority: string; due_at: Date }>(
        "SELECT id, status, priority, due_at FROM task WHERE source_type = 'device_hold' AND source_id::text = $1::text",
        [device],
      );
    const raised = await holdTasks();
    expect(raised.length).toBeGreaterThan(0);
    for (const t of raised) expect([t.status, t.priority]).toEqual(["open", "routine"]);
    await staleSession(revoker.id, async () => {
      const refused = await revoke(revoker, device);
      expect(refused.status).toBe(403);
      expect((await json<{ code: string }>(refused)).code).toBe("step_up_required");
    });
    // The device last reported an entry waiting: they confirm it first (M4).
    const unconfirmed = await revoke(revoker, device, "staff_left");
    expect(unconfirmed.status).toBe(409);
    expect(await json(unconfirmed)).toMatchObject({ code: "entries_waiting" });
    expect(
      await asTenant(
        "SELECT 1 FROM device_binding WHERE device_id = $1 AND revoked_at IS NOT NULL",
        [device],
      ),
    ).toEqual([]);
    const first = await revoke(revoker, device, "staff_left", true);
    expect(first.status).toBe(200);
    expect(await json(first)).toMatchObject({
      deviceId: device,
      replay: false,
      bindings: 1,
      entriesWaiting: 1,
      lastReportedAt: expect.any(String),
    });
    const audit = await asTenant<{ actor: string; reason: string; scope: Record<string, unknown> }>(
      "SELECT actor_tenant_user_id AS actor, reason, scope FROM audit_event WHERE action = 'platform.device.revoked' AND resource_id = $1",
      [device],
    );
    expect(audit).toEqual([
      {
        actor: DEMO.users.owner.id,
        reason: "staff_left",
        scope: { reasonCode: "staff_left", bindings: 1, memberIds: [DEMO.users.owner.id] },
      },
    ]);
    // Its hold can now drain only by a hand-over or a recorded deletion: due at once, urgent, and
    // whoever revoked it is told (#25 review round 2, M4).
    const dueNowAndUrgent = async () => {
      const tasks = await holdTasks();
      expect(tasks).toHaveLength(raised.length);
      for (const t of tasks) {
        expect([t.status, t.priority]).toEqual(["open", "urgent"]);
        expect(new Date(t.due_at).getTime()).toBeLessThanOrEqual(Date.now());
      }
    };
    await dueNowAndUrgent();
    const moved = () =>
      asTenant(
        "SELECT 1 FROM audit_event WHERE action = 'sync.device_hold.moved' AND resource_id = ANY($1)",
        [raised.map((t) => t.id)],
      ).then((rows) => rows.length);
    expect(await moved()).toBe(raised.length);
    const told = () =>
      asTenant<{ recipient: string }>(
        "SELECT recipient_tenant_user_id AS recipient FROM notification WHERE kind = 'sync.revoked_device_waiting' AND source_id = $1",
        [device],
      );
    expect(await told()).toEqual([{ recipient: DEMO.users.owner.id }]);
    // A second revocation changes nothing; it hurries the hold again, which is already due and
    // urgent, so nothing moves and nobody is told twice (#25 review round 3, low).
    const again = await json<{ replay: boolean }>(await revoke(revoker, device));
    expect(again.replay).toBe(true);
    expect(await moved()).toBe(raised.length);
    expect(await told()).toEqual([{ recipient: DEMO.users.owner.id }]);
    // A later report from the revoked device keeps its task due at once and urgent.
    const later = await freshSession("owner");
    expect((await report(later, { held: 1 }, device)).status).toBe(204);
    await dueNowAndUrgent();
    // An unknown reason is refused, and a care worker may not revoke.
    expect((await revoke(revoker, device, "because")).status).toBe(422);
    expect((await revoke("carer", device)).status).toBe(403);
  });

  it("hazard HZ-040 hurries a revoked device's hold that joined its reporter's capped-holds task (#25 review round 3, low)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0208";
    // The carer's day's cap is full whatever ran before, so this hold joins their capped-holds task.
    await asTenant(
      `INSERT INTO task (kind, title, required_permission, source_type, source_id, due_at, status, created_by)
       SELECT 'sync.device_hold', 'Unsent work on a device', 'care.plan.write', 'device_hold',
              gen_random_uuid(), now(), 'cancelled', $1
       FROM generate_series(1, 3)`,
      [DEMO.users.carer.id],
    );
    const carer = await freshSession("carer");
    await syncToken(carer, device);
    expect((await report(carer, { held: 2 }, device)).status).toBe(204);
    const [capped] = await asTenant<{ merged: string[] }>(
      "SELECT ARRAY(SELECT jsonb_array_elements_text(scope -> 'mergedInto')) AS merged FROM audit_event WHERE action = 'sync.device_hold.capped' AND resource_id = $1",
      [device],
    );
    const merged = capped?.merged ?? [];
    expect(merged.length).toBeGreaterThan(0);
    expect(
      await asTenant(
        "SELECT 1 FROM task WHERE source_type = 'device_hold' AND source_id::text = $1::text",
        [device],
      ),
    ).toEqual([]);
    expect((await revoke("manager", device, "lost_or_stolen", true)).status).toBe(200);
    const tasks = await asTenant<{ priority: string; due_at: Date }>(
      "SELECT priority, due_at FROM task WHERE id = ANY($1::uuid[])",
      [merged],
    );
    expect(tasks).toHaveLength(merged.length);
    for (const t of tasks) {
      expect(t.priority).toBe("urgent");
      expect(new Date(t.due_at).getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it("hazard HZ-006 counts refused entries the server would not copy as waiting, so the hold stays open and the device list shows them (#25 review round 3, M3)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0209";
    // The owner's hold here has the device's own tasks (their cap is three devices a day).
    const owner = await freshSession("owner");
    await syncToken(owner, device);
    expect((await report(owner, { held: 2 }, device)).status).toBe(204);
    // After a hand-over only a refused entry with no server copy is left: still waiting.
    expect((await report(owner, { held: 0, refused: 1, copiesRefused: 1 }, device)).status).toBe(
      204,
    );
    expect((await reportScopes(device)).at(-1)).toMatchObject({ waiting: 1 });
    const tasks = await asTenant<{ status: string }>(
      "SELECT status FROM task WHERE source_type = 'device_hold' AND source_id::text = $1::text",
      [device],
    );
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.status).toBe("open");
    const item = (await listed("owner")).find((d) => d.deviceId === device);
    expect(item?.entriesWaiting).toBe(1);
    expect(item?.lastReportedAt).toEqual(expect.any(String));
  });

  it("hazard HZ-011 reads a device no member the manager manages has used as not found, and refuses one staff elsewhere have also used", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0204";
    await asTenant(
      "INSERT INTO device_binding (tenant_id, device_id, tenant_user_id) VALUES ($1, $2, $3)",
      [DEMO.tenantId, device, LODGE.qualityLeadId],
    );
    expect((await revoke("manager", device)).status).toBe(404);
    expect((await revoke("manager", "0199d000-0000-4000-8000-0000000b02ff")).status).toBe(404);
    // The carer at the manager's home binds to the quality lead's device: the manager still may not
    // revoke it, so nobody withdraws another home's device by binding one of their own staff to it
    // (#25 review round 2, low).
    await asTenant(
      "INSERT INTO device_binding (tenant_id, device_id, tenant_user_id) VALUES ($1, $2, $3)",
      [DEMO.tenantId, device, DEMO.users.carer.id],
    );
    const partly = await revoke("manager", device);
    expect(partly.status).toBe(403);
    expect(
      await asTenant(
        "SELECT 1 FROM device_binding WHERE device_id = $1 AND revoked_at IS NOT NULL",
        [device],
      ),
    ).toEqual([]);
    // A tenant-wide role reaches everyone who used it.
    expect((await revoke("owner", device)).status).toBe(200);
  });

  it("hazard HZ-006 tells a revoked device apart from an expired session: 403 device_revoked to a new sign-in on it, audited once an hour", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0205";
    const carer = await freshSession("carer");
    expect((await syncToken(carer, device)).status).toBe(200);
    expect((await noteFrom(carer, device)).status).toBe(201);
    expect((await revoke("manager", device)).status).toBe(200);
    // The session that used the device is refused as a revocation, never as a lapsed sign-in, so the
    // device marks its hold revoked (#25 review round 3, M2).
    const same = await syncToken(carer, device);
    expect(same.status).toBe(403);
    expect((await json<{ code: string }>(same)).code).toBe("device_revoked");
    // Signing in again on the device, as the carer or anyone else, is refused as a revocation.
    const again = await freshSession("carer");
    const owner = await freshSession("owner");
    for (const response of [
      await syncToken(again, device),
      await syncToken(owner, device),
      await call(again, "/v1/sync/upload", {
        method: "POST",
        device,
        body: { operations: [] },
      }),
      await noteFrom(again, device),
    ]) {
      expect(response.status).toBe(403);
      expect((await json<{ code: string }>(response)).code).toBe("device_revoked");
    }
    // Audited once an hour per device, however often it retries (#25 review round 2, low).
    const refusals = await asTenant<{ route: string }>(
      "SELECT scope ->> 'route' AS route FROM audit_event WHERE action = 'sync.device.refused_revoked' AND resource_id = $1 ORDER BY seq",
      [device],
    );
    expect(refusals.map((r) => r.route)).toEqual(["sync.token"]);
    // The server still hears what the revoked device holds.
    expect((await report(again, { held: 1 }, device)).status).toBe(204);
  });

  it("hazard HZ-040 hazard HZ-006 keeps a revoked device's sessions and refuses each with device_revoked whatever it names, one that never asked for a sync token too, except its report, which never closes the task (#25 review round 3, M2)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0206";
    const another = "0199d000-0000-4000-8000-0000000b0207";
    // The owner raises their second hold in the file here: the device's own tasks.
    const user = await freshSession("owner");
    expect((await syncToken(user, device)).status).toBe(200);
    // A session that only ever wrote an entry from the device is bound by that request.
    const writer = await freshSession("owner");
    expect((await noteFrom(writer, device)).status).toBe(201);
    expect((await report(user, { held: 1 }, device)).status).toBe(204);
    const holdTasks = () =>
      asTenant<{ status: string; priority: string; due_at: Date }>(
        "SELECT status, priority, due_at FROM task WHERE source_type = 'device_hold' AND source_id::text = $1::text",
        [device],
      );
    const raised = await holdTasks();
    expect(raised.length).toBeGreaterThan(0);
    expect((await revoke("owner", device, "lost_or_stolen", true)).status).toBe(200);
    for (const session of [user, writer]) {
      for (const response of [
        await syncToken(session),
        await syncToken(session, another),
        await noteFrom(session, undefined),
        await noteFrom(session, device, handoverHeaders(DEMO.users.owner.id)),
      ]) {
        expect(response.status).toBe(403);
        expect((await json<{ code: string }>(response)).code).toBe("device_revoked");
      }
    }
    // The sessions are kept, so the device can tell a revocation from a lapsed sign-in.
    const kept = await h.db
      .pool("harbour_auth")
      .query("SELECT id FROM auth.session WHERE id = ANY($1)", [[user.id, writer.id]]);
    expect(kept.rowCount).toBe(2);
    // Its report still gets through: it may raise or hurry the task, never close it.
    const stillOpen = async () => {
      const tasks = await holdTasks();
      expect(tasks).toHaveLength(raised.length);
      for (const t of tasks) {
        expect([t.status, t.priority]).toEqual(["open", "urgent"]);
        expect(new Date(t.due_at).getTime()).toBeLessThanOrEqual(Date.now());
      }
    };
    expect((await report(user, { held: 0 }, device)).status).toBe(204);
    await stillOpen();
    expect((await report(user, { held: 2 }, device)).status).toBe(204);
    await stillOpen();
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

/** The tasks a member can read through the API, from a day ago to a month ahead. */
const tasksVisibleTo = async (who: Who) => {
  const from = new Date(Date.now() - DAY).toISOString();
  const to = new Date(Date.now() + 29 * DAY).toISOString();
  return (
    await json<{ items: { id: string; kind: string; details: Record<string, unknown> | null }[] }>(
      await call(who, `/v1/tasks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    )
  ).items;
};

describe("part 4: one open sync task per source", () => {
  it("hazard HZ-008 raises one device task per location however many reports race", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0401";
    // The manager has raised no device task today, so no daily cap merges this one.
    await syncToken("manager", device);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => report("manager", { held: 2 }, device)),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(204));
    const open = await asTenant<{ location_id: string }>(
      "SELECT location_id FROM task WHERE source_type = 'device_hold' AND source_id = $1 AND status = 'open'",
      [device],
    );
    expect(open).toEqual([{ location_id: DEMO.locationId }]);
    const raised = await asTenant(
      "SELECT 1 FROM audit_event WHERE action = 'sync.device_hold.raised' AND scope ->> 'deviceId' = $1",
      [device],
    );
    expect(raised).toHaveLength(1);
  });

  it("hazard HZ-040 gives a flagged task its owner, count and entries in its details, returned by the task route", async () => {
    const entries = [newId(), newId()];
    const id = crypto.randomUUID();
    for (const stage of ["requested", "deleted"]) {
      await discard("carer", { id, stage, entryIds: entries, owner: DEMO.users.carer.id });
    }
    for (const entry of entries) expect((await noteWithId("carer", entry)).status).toBe(201);
    const task = (await tasksVisibleTo("manager")).find(
      (t) => t.kind === "sync.entry_reported_deleted" && t.details?.entryCount === 2,
    );
    expect(task?.details).toEqual({
      ownerTenantUserId: DEMO.users.carer.id,
      entryCount: 2,
      entries: entries.map((entryId) => ({ kind: "care_note", entryId, at: expect.any(String) })),
    });
    // The care worker who uploaded them cannot see the review.
    expect((await tasksVisibleTo("carer")).map((t) => t.id)).not.toContain(task?.id);
  });
});

/** The copy of a refused note: the request the device made, as its contract has it. */
const refusal = (
  entryId: string,
  overrides: Record<string, unknown> = {},
  person: number | null = 1,
): Record<string, unknown> => ({
  entryId,
  table: "care_note",
  personId: person === null ? null : resident(person),
  payload: {
    id: entryId,
    category: "personal_care",
    body: "Assisted with a wash; skin intact.",
    occurredAt: minutesAgo(30),
  },
  httpStatus: 422,
  code: "care_event_after_exit",
  message: "The person had left before this was recorded.",
  refusedAt: minutesAgo(1),
  ...overrides,
});
const sendCopy = (
  who: As,
  body: Record<string, unknown>,
  device?: string,
  headers: Record<string, string> = {},
) =>
  call(who, "/v1/sync/refused-entries", {
    method: "POST",
    body,
    headers,
    ...(device ? { device } : {}),
  });
/** The hits a member has under a per-user limit (request_quota). */
const quotaHits = async (member: string, quota: string) => {
  const [row] = await asTenant<{ hits: unknown[] }>(
    "SELECT hits FROM request_quota WHERE tenant_user_id = $1 AND quota = $2",
    [member, quota],
  );
  return row?.hits.length ?? 0;
};

describe("part 5: copies of refused entries", () => {
  type ReviewTask = {
    id: string;
    kind: string;
    person_id: string | null;
    location_id: string | null;
    assignee_role_key: string;
    required_permission: string;
    priority: string;
    due_at: Date;
    details: { entries?: Record<string, unknown>[] } | null;
  };
  const reviewOf = (person: number) =>
    asTenant<ReviewTask>(
      `SELECT id, kind, person_id, location_id, assignee_role_key, required_permission, priority, due_at, details
       FROM task WHERE kind = 'care.refused_entry_review' AND person_id = $1 AND status = 'open'`,
      [resident(person)],
    );

  it("hazard HZ-006 a refused care entry is kept on the server with a review task", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0501";
    const entryId = newId();
    const before = Date.now();
    const response = await sendCopy("carer", refusal(entryId), device);
    expect(response.status).toBe(200);
    const result = await json<{ id: string; taskId: string; replay: boolean }>(response);
    expect(result.replay).toBe(false);
    const [copy] = await asTenant<Record<string, unknown>>(
      "SELECT entry_id, record_table, person_id, location_id, payload, refusal_code, author_tenant_user_id, created_by, device_id, review_task_id FROM refused_entry WHERE id = $1",
      [result.id],
    );
    expect(copy).toMatchObject({
      entry_id: entryId,
      record_table: "care_note",
      person_id: resident(1),
      location_id: DEMO.locationId,
      refusal_code: "care_event_after_exit",
      author_tenant_user_id: DEMO.users.carer.id,
      created_by: DEMO.users.carer.id,
      device_id: device,
      review_task_id: result.taskId,
    });
    expect((copy?.payload as Record<string, unknown> | undefined)?.body).toBe(
      "Assisted with a wash; skin intact.",
    );
    // One review for the nurse in charge, due now, listing the copy without its content.
    const [review] = await reviewOf(1);
    expect(review).toMatchObject({
      id: result.taskId,
      location_id: DEMO.locationId,
      assignee_role_key: "clinical_lead",
      required_permission: "care.plan.write",
      priority: "routine",
    });
    expect(new Date(review?.due_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(review?.due_at ?? 0).getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(review?.details?.entries).toEqual([
      expect.objectContaining({
        kind: "care_note",
        clientId: entryId,
        refusedEntryId: result.id,
        refusalCode: "care_event_after_exit",
        deviceId: device,
        recordedBy: DEMO.users.carer.id,
      }),
    ]);
    expect(JSON.stringify(review?.details)).not.toContain("wash");
    const audit = await asTenant<{ actor: string }>(
      "SELECT actor_tenant_user_id AS actor FROM audit_event WHERE action = 'sync.refused_entry.copied' AND resource_id = $1",
      [result.id],
    );
    expect(audit).toEqual([{ actor: DEMO.users.carer.id }]);
  });

  it("hazard HZ-008 adds each copy to the person's one review, urgent once an observation joins, telling the nurse in charge", async () => {
    await sendCopy("carer", refusal(newId(), {}, 2));
    await sendCopy("carer", refusal(newId(), {}, 2));
    expect((await reviewOf(2)).map((t) => t.priority)).toEqual(["routine"]);
    const observation = newId();
    const sent = await sendCopy(
      "carer",
      refusal(
        observation,
        {
          table: "observation",
          payload: {
            id: observation,
            occurredAt: minutesAgo(20),
            values: { chart: "fluid_intake", ml: 200 },
          },
        },
        2,
      ),
    );
    expect(sent.status).toBe(200);
    const reviews = await reviewOf(2);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.priority).toBe("urgent");
    expect(reviews[0]?.details?.entries).toHaveLength(3);
    // The nurse in charge is told once, without a name (#25 review round 2, M3).
    const told = await asTenant<{ title: string }>(
      "SELECT title FROM notification WHERE kind = 'care.refused_entry_urgent' AND source_id = $1",
      [reviews[0]?.id],
    );
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((n) => !n.title.includes("Example"))).toBe(true);
  });

  it("takes a replay as the same copy without counting it again, and refuses another member reusing its id", async () => {
    const entryId = newId();
    const counted = await quotaHits(DEMO.users.carer.id, "sync.refused_copies");
    const first = await json<{ id: string }>(await sendCopy("carer", refusal(entryId)));
    const again = await json<{ id: string; replay: boolean }>(
      await sendCopy("carer", refusal(entryId)),
    );
    expect(again).toMatchObject({ id: first.id, replay: true });
    // The limit counts the copy once, after the replay check (#25 review round 2, low).
    expect(await quotaHits(DEMO.users.carer.id, "sync.refused_copies")).toBe(counted + 1);
    expect((await sendCopy("manager", refusal(entryId))).status).toBe(422);
  });

  it("hazard HZ-011 reads a copy like the care record it would have been, a page at a time", async () => {
    const entryId = newId();
    const { id } = await json<{ id: string }>(await sendCopy("carer", refusal(entryId)));
    // The carer (assigned) and the manager (the location) can read it; another organisation cannot.
    for (const who of ["carer", "manager"] as const) {
      expect((await call(who, `/v1/refused-entries/${id}`)).status).toBe(200);
      const list = await json<{ items: { id: string }[] }>(
        await call(who, `/v1/people/${resident(1)}/refused-entries`),
      );
      expect(list.items.map((i) => i.id)).toContain(id);
    }
    const other = await h.request(`/v1/refused-entries/${id}`, {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    expect([403, 404]).toContain(other.status);
    // A care worker not assigned to the person cannot read it either.
    expect((await call("carer", `/v1/people/${resident(4)}/refused-entries`)).status).toBe(404);
    // Every read is audited.
    expect(
      await asTenant(
        "SELECT 1 FROM audit_event WHERE action = 'care.refused_entry.read' AND resource_id = $1",
        [id],
      ),
    ).toHaveLength(2);
    // Pages (#25 review round 2, low): newest first, then the next page from the last one's id.
    for (let i = 0; i < 3; i += 1) await sendCopy("carer", refusal(newId(), {}, 3));
    const page = async (query: string) =>
      json<{ items: { id: string }[]; nextBefore: string | null }>(
        await call("manager", `/v1/people/${resident(3)}/refused-entries${query}`),
      );
    const first = await page("?limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.nextBefore).toBe(first.items[1]?.id);
    const second = await page(`?limit=2&before=${first.nextBefore}`);
    expect(second.items).toHaveLength(1);
    expect(second.nextBefore).toBeNull();
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });

  it("hazard HZ-006 keeps a copy about someone its author cared for but can no longer see, for the manager, never for the author", async () => {
    // The carer's assignment to the fifth resident ended an hour ago, within the offline window.
    await asTenant(
      `INSERT INTO person_assignment (tenant_user_id, person_id, valid_from, valid_to)
       VALUES ($1, $2, now() - interval '2 days', now() - interval '1 hour')`,
      [DEMO.users.carer.id, resident(5)],
    );
    const response = await sendCopy("carer", refusal(newId(), {}, 5));
    expect(response.status).toBe(200);
    const { id } = await json<{ id: string }>(response);
    expect((await call("carer", `/v1/refused-entries/${id}`)).status).toBe(404);
    expect((await call("manager", `/v1/refused-entries/${id}`)).status).toBe(200);
    expect(await reviewOf(5)).toHaveLength(1);
  });

  it("hazard HZ-011 refuses a copy about someone its author never cared for exactly as one about nobody known here (#25 review round 2, M2)", async () => {
    // The carer was never assigned to the fourth resident, who lives at the carer's home.
    const planted = await sendCopy("carer", refusal(newId(), {}, 4));
    const unknown = await sendCopy(
      "carer",
      refusal(newId(), { personId: "0199d000-0000-4000-8000-0000000b05ff" }),
    );
    expect(planted.status).toBe(422);
    expect(unknown.status).toBe(422);
    const strip = (p: Record<string, unknown>) => ({ ...p, requestId: undefined });
    expect(strip(await json(planted))).toEqual(strip(await json(unknown)));
    expect(await reviewOf(4)).toHaveLength(0);
  });

  it("joins a copy about nobody to its author's review at their location", async () => {
    const entryId = newId();
    const { id, taskId } = await json<{ id: string; taskId: string }>(
      await sendCopy("carer", refusal(entryId, {}, null)),
    );
    const [copy] = await asTenant<{ person_id: string | null; location_id: string | null }>(
      "SELECT person_id, location_id FROM refused_entry WHERE id = $1",
      [id],
    );
    expect(copy).toEqual({ person_id: null, location_id: DEMO.locationId });
    const [task] = await asTenant<{ source_type: string; source_id: string }>(
      "SELECT source_type, source_id FROM task WHERE id = $1",
      [taskId],
    );
    expect(task).toEqual({ source_type: "tenant_user", source_id: DEMO.users.carer.id });
  });

  it("refuses content that is not the entry kind's own request, names another entry, has unknown fields or a code that is not a code (#25 review round 2, M2)", async () => {
    const entryId = newId();
    const note = refusal(entryId).payload as Record<string, unknown>;
    for (const body of [
      refusal(entryId, { payload: { ...note, id: newId() } }),
      refusal(entryId, { payload: { ...note, person_id: resident(2) } }),
      refusal(entryId, { payload: { ...note, body: undefined } }),
      refusal(entryId, { table: "observation" }),
      { ...refusal(entryId), extra: "field" },
      refusal(entryId, { code: "Not a code" }),
      refusal(entryId, { table: "person" }),
    ]) {
      expect((await sendCopy("carer", body)).status).toBe(422);
    }
    // Members without care.note.write may not send copies.
    expect((await sendCopy("quality", refusal(entryId))).status).toBe(403);
  });

  it("hazard HZ-040 refuses a revoked device's copy unless it comes with a hand-over (#25 review round 2, M2)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0520";
    const carer = await freshSession("carer");
    await syncToken(carer, device);
    expect(
      (
        await call("manager", `/v1/devices/${device}/revoke`, {
          method: "POST",
          body: { reasonCode: "lost_or_stolen" },
        })
      ).status,
    ).toBe(200);
    const again = await freshSession("carer");
    const refused = await sendCopy(again, refusal(newId()), device);
    expect(refused.status).toBe(403);
    expect((await json<{ code: string }>(refused)).code).toBe("device_revoked");
  });
});

/** The headers of a hand-over of the owner's held entries. */
const handoverHeaders = (owner: string, handoverId: string = crypto.randomUUID()) => ({
  [HANDOVER_OWNER_HEADER]: owner,
  [HANDOVER_ID_HEADER]: handoverId,
});

describe("part 6: hand-over of held entries", () => {
  beforeAll(async () => {
    // The carer has cared for their three residents for a month: a hand-over judges an entry by
    // the owner's care when it was written, not when the test database was seeded.
    await asTenant(
      "UPDATE person_assignment SET valid_from = now() - interval '30 days' WHERE tenant_user_id = $1 AND valid_to IS NULL",
      [DEMO.users.carer.id],
    );
  });
  const entryRow = (id: string) =>
    asTenant<{
      created_by: string;
      handed_over_by: string | null;
      device_id: string | null;
      task_outcome: string | null;
    }>("SELECT created_by, handed_over_by, device_id, task_outcome FROM care_note WHERE id = $1", [
      id,
    ]);
  const handedOver = (id: string) =>
    asTenant<{ actor: string; scope: Record<string, unknown> }>(
      "SELECT actor_tenant_user_id AS actor, scope FROM audit_event WHERE action = 'sync.entry.handed_over' AND resource_id = $1",
      [id],
    );
  /**
   * A device holding `held` of the carer's entries: the carer first used it a day ago, and their
   * session reported the hold.
   */
  async function holdFor(device: string, held: number) {
    await asTenant(
      `INSERT INTO device_binding (tenant_id, device_id, tenant_user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '1 day', now() - interval '1 day')`,
      [DEMO.tenantId, device, DEMO.users.carer.id],
    );
    const carer = await freshSession("carer");
    expect(
      (await report(carer, { held, ownerTenantUserId: DEMO.users.carer.id }, device)).status,
    ).toBe(204);
  }
  /** A manager signs in on the device and sends its report first, as the app does. */
  async function managerOn(device: string, held: number) {
    const manager = await freshSession("manager");
    expect(
      (await report(manager, { held, ownerTenantUserId: DEMO.users.carer.id }, device)).status,
    ).toBe(204);
    return manager;
  }
  const refusedAs = async (response: Response) => {
    expect(response.status).toBe(422);
    return (await json<{ code: string; detail?: string }>(response)).code;
  };

  it("hazard HZ-040 a manager hands over a member's held entries: written as the owner's, sent by the manager, recorded", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0601";
    await holdFor(device, 2);
    const manager = await managerOn(device, 2);
    const id = newId();
    const handoverId = crypto.randomUUID();
    const response = await noteFrom(
      manager,
      device,
      handoverHeaders(DEMO.users.carer.id, handoverId),
      id,
    );
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({
      recordedBy: DEMO.users.carer.id,
      handedOverBy: DEMO.users.manager.id,
    });
    expect(await entryRow(id)).toEqual([
      {
        created_by: DEMO.users.carer.id,
        handed_over_by: DEMO.users.manager.id,
        device_id: device,
        task_outcome: null,
      },
    ]);
    expect(await handedOver(id)).toEqual([
      {
        actor: DEMO.users.manager.id,
        scope: {
          ownerTenantUserId: DEMO.users.carer.id,
          heldOnDeviceId: device,
          handoverId,
          byOwner: false,
        },
      },
    ]);
    expect(
      await asTenant(
        "SELECT handover_id, owner_tenant_user_id AS owner, sent_by FROM handed_over_entry WHERE entry_id = $1",
        [id],
      ),
    ).toEqual([
      { handover_id: handoverId, owner: DEMO.users.carer.id, sent_by: DEMO.users.manager.id },
    ]);
    // "Sent by" in the record as every reader gets it (H1).
    const notes = await json<{ items: { id: string; handedOverBy: string | null }[] }>(
      await call("manager", `/v1/people/${resident(1)}/notes`),
    );
    expect(notes.items.find((n) => n.id === id)?.handedOverBy).toBe(DEMO.users.manager.id);
    // An ordinary upload is not a hand-over and records none.
    const own = newId();
    const mine = await noteFrom("carer", device, {}, own);
    expect(mine.status).toBe(201);
    expect((await json<{ handedOverBy: string | null }>(mine)).handedOverBy).toBeNull();
    expect(await handedOver(own)).toEqual([]);
  });

  it("hazard HZ-040 needs the hand-over permission and a fresh sign-in for someone else's entries", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0602";
    await syncToken("carer", device);
    await syncToken("manager", device);
    await staleSignIn("owner", async () => {
      const refused = await noteFrom("owner", device, handoverHeaders(DEMO.users.carer.id));
      expect(refused.status).toBe(403);
      expect((await json<{ code: string }>(refused)).code).toBe("step_up_required");
    });
    // A care worker may not send another member's entries.
    const carer = await noteFrom("carer", device, handoverHeaders(DEMO.users.manager.id));
    expect(carer.status).toBe(403);
    expect((await json<{ code: string }>(carer)).code).toBe("missing_permission");
  });

  it("hazard HZ-040 refuses an owner who never used the device, or a hand-over without its device or id", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0603";
    await holdFor(device, 1);
    const manager = await managerOn(device, 1);
    // The nurse never used this device: their name cannot be put on entries from it.
    expect(
      await refusedAs(await noteFrom(manager, device, handoverHeaders(DEMO.users.nurse.id))),
    ).toBe("handover_refused");
    // Another organisation's member is not staff here.
    expect(await refusedAs(await noteFrom(manager, device, handoverHeaders(OTHER.managerId)))).toBe(
      "handover_refused",
    );
    expect(
      await refusedAs(await noteFrom(manager, undefined, handoverHeaders(DEMO.users.carer.id))),
    ).toBe("invalid");
    expect(
      await refusedAs(
        await noteFrom(manager, device, {
          [HANDOVER_OWNER_HEADER]: DEMO.users.carer.id,
          [HANDOVER_ID_HEADER]: "not-an-id",
        }),
      ),
    ).toBe("invalid");
  });

  it("hazard HZ-040 hazard HZ-004 refuses a sender who never used the device: the device sends its report as the sender first (#25 review round 2, H1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0610";
    await holdFor(device, 2);
    const owner = await freshSession("owner");
    expect(
      await refusedAs(await noteFrom(owner, device, handoverHeaders(DEMO.users.carer.id))),
    ).toBe("handover_refused");
    // Once their sign-in has reported from the device, they are bound and the entry is taken.
    await report(owner, { held: 2, ownerTenantUserId: DEMO.users.carer.id }, device);
    expect((await noteFrom(owner, device, handoverHeaders(DEMO.users.carer.id))).status).toBe(201);
  });

  it("hazard HZ-040 hazard HZ-004 takes no more entries than the hold reported, however much the sender reports (#25 review round 2, H1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0611";
    await holdFor(device, 1);
    // The sender's own report cannot raise the count the carer's session reported.
    const manager = await managerOn(device, 5);
    const handoverId = crypto.randomUUID();
    const first = newId();
    const headers = handoverHeaders(DEMO.users.carer.id, handoverId);
    expect((await noteFrom(manager, device, headers, first)).status).toBe(201);
    // A replay of the same entry is not counted again.
    expect((await noteFrom(manager, device, headers, first)).status).toBe(201);
    expect(await refusedAs(await noteFrom(manager, device, headers))).toBe("handover_refused");
  });

  it("hazard HZ-040 hazard HZ-004 refuses a hand-over once the device reports nothing waiting for the owner (#25 review round 2, H1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0612";
    await holdFor(device, 1);
    const manager = await managerOn(device, 1);
    const carer = await freshSession("carer");
    expect((await report(carer, { held: 0 }, device)).status).toBe(204);
    expect(
      await refusedAs(await noteFrom(manager, device, handoverHeaders(DEMO.users.carer.id))),
    ).toBe("handover_refused");
  });

  it("hazard HZ-040 hazard HZ-004 refuses an entry timed before the owner first used the device (#25 review round 2, H1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0613";
    await holdFor(device, 2);
    const manager = await managerOn(device, 2);
    const early = await call(manager, `/v1/people/${resident(1)}/notes`, {
      method: "POST",
      device,
      headers: handoverHeaders(DEMO.users.carer.id),
      body: {
        id: newId(),
        category: "personal_care",
        body: "Assisted with a wash; skin intact.",
        occurredAt: new Date(Date.now() - 2 * DAY).toISOString(),
      },
    });
    expect(await refusedAs(early)).toBe("handover_refused");
  });

  it("hazard HZ-040 hazard HZ-004 refuses an entry about someone never in the owner's care, though the manager may see them (#25 review round 2, H1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0615";
    await holdFor(device, 2);
    const manager = await managerOn(device, 2);
    // The carer was never assigned to the fourth resident; the manager covers the whole home.
    expect(
      await refusedAs(
        await noteFrom(manager, device, handoverHeaders(DEMO.users.carer.id), newId(), 4),
      ),
    ).toBe("handover_refused");
    expect((await noteFrom("manager", undefined, {}, newId(), 4)).status).toBe(201);
  });

  it("hazard HZ-040 hazard HZ-004 refuses a hand-over id reused for another owner (#25 review round 2, H1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0616";
    await holdFor(device, 2);
    const manager = await managerOn(device, 2);
    const handoverId = crypto.randomUUID();
    expect(
      (await noteFrom(manager, device, handoverHeaders(DEMO.users.carer.id, handoverId))).status,
    ).toBe(201);
    // The nurse used the device too: the same hand-over id cannot name them as well.
    await asTenant(
      `INSERT INTO device_binding (tenant_id, device_id, tenant_user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '1 day', now() - interval '1 day')`,
      [DEMO.tenantId, device, DEMO.users.nurse.id],
    );
    const reused = await noteFrom(
      manager,
      device,
      handoverHeaders(DEMO.users.nurse.id, handoverId),
    );
    expect(await refusedAs(reused)).toBe("handover_refused");
  });

  it("hazard HZ-040 hazard HZ-004 takes a hand-over from a revoked device only for entries recorded before the revocation, the owner's own as well as a manager's", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0614";
    await holdFor(device, 3);
    await managerOn(device, 3);
    const owner = await freshSession("owner");
    expect(
      (
        await call(owner, `/v1/devices/${device}/revoke`, {
          method: "POST",
          body: { reasonCode: "lost_or_stolen", confirmEntriesWaiting: true },
        })
      ).status,
    ).toBe(200);
    // The manager's session that reported is bound to the revoked device and refused everything
    // but its report: the manager signs in again and reports (#25 review round 3, M2).
    const manager = await managerOn(device, 3);
    expect((await noteFrom(manager, device)).status).toBe(403);
    const byManager = newId();
    expect(
      (await noteFrom(manager, device, handoverHeaders(DEMO.users.carer.id), byManager)).status,
    ).toBe(201);
    // Nothing written on the device after the revocation, beyond the clock-drift tolerance, is
    // taken (#25 review rounds 2 and 3, M1).
    const afterRevocation = {
      occurredAt: new Date().toISOString(),
      deviceTime: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    const late = await noteAt(
      manager,
      device,
      handoverHeaders(DEMO.users.carer.id),
      afterRevocation,
    );
    expect(await json(late)).toMatchObject({
      code: "handover_refused",
      detail: expect.stringMatching(/withdrawn/),
    });
    // The owner sends their own from the revoked device: no manager's permission needed.
    const carer = await freshSession("carer");
    const byOwner = newId();
    const own = await noteFrom(carer, device, handoverHeaders(DEMO.users.carer.id), byOwner);
    expect(own.status).toBe(201);
    expect((await json<{ handedOverBy: string | null }>(own)).handedOverBy).toBeNull();
    expect((await handedOver(byOwner))[0]?.scope).toMatchObject({ byOwner: true });
    // The owner's own entry written after the revocation is refused too (#25 review round 2, M1).
    const ownLate = await noteAt(
      carer,
      device,
      handoverHeaders(DEMO.users.carer.id),
      afterRevocation,
    );
    expect(await json(ownLate)).toMatchObject({
      code: "handover_refused",
      detail: expect.stringMatching(/withdrawn/),
    });
    // Their refusals' copies too, in the owner's name, counted against the owner.
    const counted = await quotaHits(DEMO.users.carer.id, "sync.refused_copies");
    const managerCounted = await quotaHits(DEMO.users.manager.id, "sync.refused_copies");
    const refused = newId();
    const copy = await sendCopy(
      manager,
      refusal(refused),
      device,
      handoverHeaders(DEMO.users.carer.id),
    );
    expect(copy.status).toBe(200);
    const [kept] = await asTenant<{ author: string; sender: string }>(
      "SELECT author_tenant_user_id AS author, created_by AS sender FROM refused_entry WHERE entry_id = $1",
      [refused],
    );
    expect(kept).toEqual({ author: DEMO.users.carer.id, sender: DEMO.users.manager.id });
    expect(await quotaHits(DEMO.users.carer.id, "sync.refused_copies")).toBe(counted + 1);
    expect(await quotaHits(DEMO.users.manager.id, "sync.refused_copies")).toBe(managerCounted);
  });

  it("hazard HZ-040 hazard HZ-004 never counts the sender's own reports: a manager who reports nothing and then a large count cannot hand over (#25 review round 3)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0623";
    await holdFor(device, 2);
    const manager = await freshSession("manager");
    const owner = { ownerTenantUserId: DEMO.users.carer.id };
    expect((await report(manager, { held: 0, ...owner }, device)).status).toBe(204);
    expect((await report(manager, { held: 50, ...owner }, device)).status).toBe(204);
    const refused = await noteFrom(manager, device, handoverHeaders(DEMO.users.carer.id));
    expect(refused.status).toBe(422);
    expect(await json(refused)).toMatchObject({
      code: "handover_refused",
      detail: expect.stringMatching(/Only your own reports/),
    });
  });

  it("hazard HZ-040 hazard HZ-004 counts a hand-over against the owner's latest report in the hold, not an earlier smaller one nor what the sender reports (#25 review round 3)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0624";
    await holdFor(device, 1);
    // The carer's later report in the same hold: three waiting.
    const carer = await freshSession("carer");
    expect(
      (await report(carer, { held: 3, ownerTenantUserId: DEMO.users.carer.id }, device)).status,
    ).toBe(204);
    const manager = await managerOn(device, 9);
    const headers = handoverHeaders(DEMO.users.carer.id);
    for (let sent = 0; sent < 3; sent += 1) {
      expect((await noteFrom(manager, device, headers)).status).toBe(201);
    }
    expect(await refusedAs(await noteFrom(manager, device, headers))).toBe("handover_refused");
  });

  it("hazard HZ-040 hazard HZ-006 takes a bank carer's night entries handed over next morning, though their access ended at shift end and the device clock ran a little slow (#25 review round 3, M1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0620";
    // Signed in on the device 14 hours ago for a night shift with the fifth resident, whose
    // assignment ended with the shift 2 hours ago.
    await asTenant(
      `INSERT INTO device_binding (tenant_id, device_id, tenant_user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '14 hours', now() - interval '2 hours')`,
      [DEMO.tenantId, device, DEMO.users.carer.id],
    );
    await asTenant(
      `INSERT INTO person_assignment (tenant_user_id, person_id, valid_from, valid_to)
       VALUES ($1, $2, now() - interval '15 hours', now() - interval '2 hours')`,
      [DEMO.users.carer.id, resident(5)],
    );
    const carer = await freshSession("carer");
    const owner = { ownerTenantUserId: DEMO.users.carer.id };
    // An earlier, smaller report in the shift, then the hold's report at its end.
    expect((await report(carer, { unsent: 1, ...owner }, device)).status).toBe(204);
    expect((await report(carer, { held: 3, ...owner }, device)).status).toBe(204);
    const manager = await managerOn(device, 3);
    const headers = handoverHeaders(DEMO.users.carer.id);
    const ago = (hours: number, minutes = 0) =>
      new Date(Date.now() - hours * 3_600_000 - minutes * 60_000).toISOString();
    for (const time of [
      ago(10),
      // Written at the start of the shift on a device clock 3 minutes slow.
      ago(14, 3),
      ago(3),
    ]) {
      const response = await noteAt(
        manager,
        device,
        headers,
        { occurredAt: time, deviceTime: time },
        5,
      );
      expect(response.status).toBe(201);
    }
  });

  it("hazard HZ-040 hazard HZ-006 judges a back-dated entry by when it was written on the device: a 07:30 wash written after an 08:00 sign-in is taken, an entry written before the sign-in is not (#25 review round 3, M1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0621";
    // The carer first used the device a day ago ("08:00").
    await holdFor(device, 2);
    const manager = await managerOn(device, 2);
    const headers = handoverHeaders(DEMO.users.carer.id);
    const signIn = Date.now() - DAY;
    const at = (minutes: number) => new Date(signIn + minutes * 60_000).toISOString();
    const wash = await noteAt(manager, device, headers, {
      occurredAt: at(-30),
      deviceTime: at(10),
    });
    expect(wash.status).toBe(201);
    const before = await noteAt(manager, device, headers, {
      occurredAt: at(-20),
      deviceTime: at(-20),
    });
    expect(await json(before)).toMatchObject({
      code: "handover_refused",
      detail: expect.stringMatching(/before that member of staff first used this device/),
    });
  });

  it("hazard HZ-040 hazard HZ-006 takes entries whose owner's care ended more than the offline window before the hand-over, as after a weekend or a hold left to escalate, judged from each entry's time (#25 review round 3, M1)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0622";
    await asTenant(
      `INSERT INTO device_binding (tenant_id, device_id, tenant_user_id, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, now() - interval '10 days', now() - interval '8 days')`,
      [DEMO.tenantId, device, DEMO.users.carer.id],
    );
    // The carer cared for the sixth resident from 10 to 8 days ago; the offline window is 7 days.
    await asTenant(
      `INSERT INTO person_assignment (tenant_user_id, person_id, valid_from, valid_to)
       VALUES ($1, $2, now() - interval '10 days', now() - interval '8 days')`,
      [DEMO.users.carer.id, resident(6)],
    );
    const carer = await freshSession("carer");
    expect(
      (await report(carer, { held: 2, ownerTenantUserId: DEMO.users.carer.id }, device)).status,
    ).toBe(204);
    const manager = await managerOn(device, 2);
    const headers = handoverHeaders(DEMO.users.carer.id);
    // An entry written today about the sixth resident was not written in the carer's care.
    const today = await noteAt(manager, device, headers, { occurredAt: minutesAgo(5) }, 6);
    expect(await json(today)).toMatchObject({
      code: "handover_refused",
      detail: expect.stringMatching(/not in that member of staff's care/),
    });
    // One written nine days ago was, and the refusal above used none of the hold's count.
    const nineDaysAgo = new Date(Date.now() - 9 * DAY).toISOString();
    for (let sent = 0; sent < 2; sent += 1) {
      const response = await noteAt(
        manager,
        device,
        headers,
        { occurredAt: nineDaysAgo, deviceTime: nineDaysAgo },
        6,
      );
      expect(response.status).toBe(201);
    }
  });

  it("hazard HZ-040 uses none of the hold's count for an entry refused after its admission: both are in one transaction (#25 review round 3)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0625";
    await holdFor(device, 1);
    const manager = await managerOn(device, 1);
    const headers = handoverHeaders(DEMO.users.carer.id);
    const id = newId();
    // A correction of an entry that is not there: admitted, then refused in the same transaction.
    const refused = await call(manager, `/v1/people/${resident(1)}/notes`, {
      method: "POST",
      device,
      headers,
      body: {
        id,
        category: "personal_care",
        body: "Assisted with a wash; skin intact.",
        occurredAt: minutesAgo(5),
        supersedesId: newId(),
        correctionReason: "The time was wrong.",
      },
    });
    expect(refused.status).toBe(422);
    expect((await json<{ code: string }>(refused)).code).toBe("invalid");
    expect(await asTenant("SELECT 1 FROM handed_over_entry WHERE entry_id = $1", [id])).toEqual([]);
    expect((await noteFrom(manager, device, headers)).status).toBe(201);
  });

  it("hazard HZ-040 hazard HZ-006 counts a handed-over copy of a refused entry against the hold like the entry it is (#25 review round 3)", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0626";
    await holdFor(device, 1);
    const manager = await managerOn(device, 1);
    const headers = handoverHeaders(DEMO.users.carer.id);
    const copied = newId();
    expect((await sendCopy(manager, refusal(copied), device, headers)).status).toBe(200);
    expect(
      await asTenant<{ record_table: string; sent_by: string }>(
        "SELECT record_table, sent_by FROM handed_over_entry WHERE entry_id = $1",
        [copied],
      ),
    ).toEqual([{ record_table: "care_note", sent_by: DEMO.users.manager.id }]);
    expect(await refusedAs(await noteFrom(manager, device, headers))).toBe("handover_refused");
    // A replay of the copy is the same copy, counted once.
    expect((await sendCopy(manager, refusal(copied), device, headers)).status).toBe(200);
  });

  it("hazard HZ-004 judges the round a handed-over entry answers on its owner's permission when the care was recorded, never the manager's", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0605";
    await holdFor(device, 2);
    const manager = await managerOn(device, 2);
    // A round only someone holding care.plan.write may complete: the manager may, the carer may not.
    const round = async () => {
      const [made] = await asTenant<{ id: string }>(
        `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at)
         VALUES ($1, $2, 'care.plan_action', 'Review the plan', 'care.plan.write', now()) RETURNING id`,
        [resident(1), DEMO.locationId],
      );
      return made?.id ?? "";
    };
    const handedTask = await round();
    const id = newId();
    const response = await call(manager, `/v1/people/${resident(1)}/notes`, {
      method: "POST",
      device,
      headers: handoverHeaders(DEMO.users.carer.id),
      body: {
        id,
        category: "personal_care",
        body: "Assisted with a wash; skin intact.",
        occurredAt: minutesAgo(5),
        taskId: handedTask,
      },
    });
    expect(response.status).toBe(201);
    const [status] = await asTenant<{ status: string }>("SELECT status FROM task WHERE id = $1", [
      handedTask,
    ]);
    expect(status?.status).toBe("open");
    expect((await entryRow(id))[0]?.task_outcome).not.toBe("completed");
    // The manager's own entry completes the same kind of round.
    const ownTask = await round();
    await call("manager", `/v1/people/${resident(1)}/notes`, {
      method: "POST",
      body: {
        id: newId(),
        category: "personal_care",
        body: "Assisted with a wash; skin intact.",
        occurredAt: minutesAgo(5),
        taskId: ownTask,
      },
    });
    const [own] = await asTenant<{ status: string }>("SELECT status FROM task WHERE id = $1", [
      ownTask,
    ]);
    expect(own?.status).toBe("done");
  });
});

describe("part 7: shared per-user quotas", () => {
  it("hazard HZ-023 counts a member's requests across every API instance, in request_quota", async () => {
    // A second instance over the same database, as a second container behind the load balancer.
    const second = createApp(h.handle.services.config, createLogger("silent"));
    try {
      const device = "0199d000-0000-4000-8000-0000000b0701";
      const viaSecond = () =>
        second.app.request("/v1/sync/device-report", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${h.tokens.quality}`,
            [TENANT_HEADER]: DEMO.tenantId,
            [DEVICE_HEADER]: device,
          },
          body: JSON.stringify({
            unsent: 0,
            refused: 0,
            held: 0,
            blocked: 0,
            oldestAgeSeconds: null,
            reportedAt: new Date().toISOString(),
          }),
        });
      // 120 reports an hour (REPORTS_PER_HOUR), half through each instance.
      for (let i = 0; i < 60; i += 1) {
        expect((await report("quality", {}, device)).status).toBe(204);
        expect((await viaSecond()).status).toBe(204);
      }
      for (const refused of [await report("quality", {}, device), await viaSecond()]) {
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      const rows = await asTenant<{ quota: string; hits: unknown[] }>(
        "SELECT quota, hits FROM request_quota WHERE tenant_user_id = $1",
        [LODGE.qualityLeadId],
      );
      expect(rows.map((r) => [r.quota, r.hits.length])).toEqual([["sync.reports", 120]]);
      // Someone else's limit is their own.
      expect((await report("manager", {}, device)).status).toBe(204);
    } finally {
      await second.close();
    }
  }, 60_000);
});

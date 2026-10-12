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
    ...(person === null ? {} : { person_id: resident(person) }),
    category: "personal_care",
    body: "Assisted with a wash; skin intact.",
    occurred_at: minutesAgo(30),
  },
  httpStatus: 422,
  code: "care_event_after_exit",
  message: "The person had left before this was recorded.",
  refusedAt: minutesAgo(1),
  ...overrides,
});
const sendCopy = (who: Who, body: Record<string, unknown>, device?: string) =>
  call(who, "/v1/sync/refused-entries", { method: "POST", body, ...(device ? { device } : {}) });

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

  it("hazard HZ-008 adds each copy to the person's one review, urgent once an observation joins", async () => {
    await sendCopy("carer", refusal(newId(), {}, 2));
    await sendCopy("carer", refusal(newId(), {}, 2));
    expect((await reviewOf(2)).map((t) => t.priority)).toEqual(["routine"]);
    const observation = newId();
    await sendCopy(
      "carer",
      refusal(
        observation,
        {
          table: "observation",
          payload: { id: observation, person_id: resident(2), chart: "fluid_intake" },
        },
        2,
      ),
    );
    const reviews = await reviewOf(2);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.priority).toBe("urgent");
    expect(reviews[0]?.details?.entries).toHaveLength(3);
  });

  it("takes a replay as the same copy, and refuses another member reusing its id", async () => {
    const entryId = newId();
    const first = await json<{ id: string }>(await sendCopy("carer", refusal(entryId)));
    const again = await json<{ id: string; replay: boolean }>(
      await sendCopy("carer", refusal(entryId)),
    );
    expect(again).toMatchObject({ id: first.id, replay: true });
    expect((await sendCopy("manager", refusal(entryId))).status).toBe(422);
  });

  it("hazard HZ-011 reads a copy like the care record it would have been", async () => {
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
    // Another organisation's manager never reads it (no copy there to read: row-level security, as
    // packages/db/test/device-integrity.test.ts proves; here refused before the read).
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
  });

  it("hazard HZ-006 keeps a copy its author can no longer see, for the manager, never for the author", async () => {
    // The carer is not assigned to the fourth resident (an assignment ended, say).
    const entryId = newId();
    const response = await sendCopy("carer", refusal(entryId, {}, 4));
    expect(response.status).toBe(200);
    const { id } = await json<{ id: string }>(response);
    expect((await call("carer", `/v1/refused-entries/${id}`)).status).toBe(404);
    expect((await call("manager", `/v1/refused-entries/${id}`)).status).toBe(200);
    expect(await reviewOf(4)).toHaveLength(1);
  });

  it("joins a copy about nobody known to its author's review at their location", async () => {
    const entryId = newId();
    const { id, taskId } = await json<{ id: string; taskId: string }>(
      await sendCopy(
        "carer",
        refusal(
          entryId,
          { personId: "0199d000-0000-4000-8000-0000000b05ff", payload: { id: entryId } },
          null,
        ),
      ),
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

  it("refuses content that names another entry or person, unknown fields and a code that is not a code", async () => {
    const entryId = newId();
    for (const body of [
      refusal(entryId, { payload: { id: newId() } }),
      refusal(entryId, { payload: { person_id: resident(2) } }),
      { ...refusal(entryId), extra: "field" },
      refusal(entryId, { code: "Not a code" }),
      refusal(entryId, { table: "person" }),
    ]) {
      expect((await sendCopy("carer", body)).status).toBe(422);
    }
    // Members without care.note.write may not send copies.
    expect((await sendCopy("quality", refusal(entryId))).status).toBe(403);
  });
});

describe("part 6: hand-over of held entries", () => {
  const handoverHeaders = (owner: string, handoverId = crypto.randomUUID()) => ({
    [HANDOVER_OWNER_HEADER]: owner,
    [HANDOVER_ID_HEADER]: handoverId,
  });
  const entryRow = (id: string) =>
    asTenant<{ created_by: string; device_id: string | null; task_outcome: string | null }>(
      "SELECT created_by, device_id, task_outcome FROM care_note WHERE id = $1",
      [id],
    );
  const handedOver = (id: string) =>
    asTenant<{ actor: string; scope: Record<string, unknown> }>(
      "SELECT actor_tenant_user_id AS actor, scope FROM audit_event WHERE action = 'sync.entry.handed_over' AND resource_id = $1",
      [id],
    );

  it("hazard HZ-040 a manager hands over a member's held entries: written as the owner's, with the manager recorded", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0601";
    await syncToken("carer", device);
    const id = newId();
    const handoverId = crypto.randomUUID();
    const response = await noteFrom(
      "manager",
      device,
      handoverHeaders(DEMO.users.carer.id, handoverId),
      id,
    );
    expect(response.status).toBe(201);
    expect((await json<{ recordedBy: string }>(response)).recordedBy).toBe(DEMO.users.carer.id);
    expect(await entryRow(id)).toEqual([
      { created_by: DEMO.users.carer.id, device_id: device, task_outcome: null },
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
    // An ordinary upload is not a hand-over and records none.
    const own = newId();
    expect((await noteFrom("carer", device, {}, own)).status).toBe(201);
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
    await syncToken("carer", device);
    // The nurse never used this device: their name cannot be put on entries from it.
    expect((await noteFrom("manager", device, handoverHeaders(DEMO.users.nurse.id))).status).toBe(
      422,
    );
    // Another organisation's member is not staff here.
    expect((await noteFrom("manager", device, handoverHeaders(OTHER.managerId))).status).toBe(422);
    expect(
      (await noteFrom("manager", undefined, handoverHeaders(DEMO.users.carer.id))).status,
    ).toBe(422);
    expect(
      (
        await noteFrom("manager", device, {
          [HANDOVER_OWNER_HEADER]: DEMO.users.carer.id,
          [HANDOVER_ID_HEADER]: "not-an-id",
        })
      ).status,
    ).toBe(422);
  });

  it("hazard HZ-040 takes a hand-over from a revoked device, the owner's own as well as a manager's", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0604";
    await syncToken("carer", device);
    expect(
      (
        await call("manager", `/v1/devices/${device}/revoke`, {
          method: "POST",
          body: { reasonCode: "lost_or_stolen" },
        })
      ).status,
    ).toBe(200);
    expect((await noteFrom("carer", device)).status).toBe(403);
    const byManager = newId();
    expect(
      (await noteFrom("manager", device, handoverHeaders(DEMO.users.carer.id), byManager)).status,
    ).toBe(201);
    // The owner sends their own from the revoked device: no manager's permission needed.
    const byOwner = newId();
    expect(
      (await noteFrom("carer", device, handoverHeaders(DEMO.users.carer.id), byOwner)).status,
    ).toBe(201);
    expect((await handedOver(byOwner))[0]?.scope).toMatchObject({ byOwner: true });
    // Their refusals' copies too, in the owner's name.
    const refused = newId();
    const copy = await call("manager", "/v1/sync/refused-entries", {
      method: "POST",
      device,
      headers: handoverHeaders(DEMO.users.carer.id),
      body: refusal(refused),
    });
    expect(copy.status).toBe(200);
    const [kept] = await asTenant<{ author: string; sender: string }>(
      "SELECT author_tenant_user_id AS author, created_by AS sender FROM refused_entry WHERE entry_id = $1",
      [refused],
    );
    expect(kept).toEqual({ author: DEMO.users.carer.id, sender: DEMO.users.manager.id });
  });

  it("hazard HZ-004 judges the round a handed-over entry answers on its owner's permission when the care was recorded, never the manager's", async () => {
    const device = "0199d000-0000-4000-8000-0000000b0605";
    await syncToken("carer", device);
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
    const response = await call("manager", `/v1/people/${resident(1)}/notes`, {
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

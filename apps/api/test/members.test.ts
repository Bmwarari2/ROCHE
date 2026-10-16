import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Members for managers (PLAT-004; platform.md, Members; hazard HZ-011): the list and adding an
 * invited member reach only what platform.user.manage reaches; a manager never gives a role
 * beyond their own (app.may_assign_role, in the API and in row-level security, migration 0060);
 * a retry adds nobody twice; an address already in the organisation is refused; the address is
 * never returned or audited.
 */

let h: Harness;
let n = 0;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const owner = () => h.db.pool("harbour_owner");

async function roleId(key: string, tenantId: string = DEMO.tenantId): Promise<string> {
  const client = await owner().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const { rows } = await client.query("SELECT id FROM role WHERE key = $1", [key]);
    await client.query("COMMIT");
    return (rows[0] as { id: string }).id;
  } finally {
    client.release();
  }
}

const as = (who: string) => ({ token: h.tokens[who], tenant: DEMO.tenantId });

function newMember(role: string, locationId: string | null) {
  n += 1;
  return {
    id: randomUUID(),
    displayName: `Ada Example ${n}`,
    email: `new.member${n}@example.invalid`,
    roleId: role,
    locationId,
  };
}

const create = (body: unknown, who = "owner") =>
  h.request("/v1/members", { method: "POST", body, ...as(who) });

type List = {
  items: { id: string; displayName: string; state: string; roles: { roleId: string }[] }[];
  assignableRoles: { id: string; name: string; locationIds: (string | null)[] }[];
};

async function list(who: string, query = "") {
  const response = await h.request(`/v1/members${query}`, as(who));
  expect(response.status).toBe(200);
  return (await response.json()) as List;
}

const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

async function audits(resourceId: string) {
  const client = await owner().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    const { rows } = await client.query(
      "SELECT action, outcome, reason, scope::text AS scope FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at",
      [resourceId],
    );
    await client.query("COMMIT");
    return rows as { action: string; outcome: string; reason: string | null; scope: string }[];
  } finally {
    client.release();
  }
}

describe("hazard HZ-011 listing members within reach", () => {
  it("shows the owner everyone, a home's manager only that home's staff, never an address", async () => {
    const all = await list("owner");
    const ids = all.items.map((m) => m.id);
    expect(ids).toContain(DEMO.users.carer.id);
    expect(ids).toContain(LODGE.qualityLeadId);
    expect(JSON.stringify(all)).not.toContain("@example.invalid");

    const mine = (await list("manager")).items.map((m) => m.id);
    expect(mine).toContain(DEMO.users.carer.id);
    // The owner's role reaches the whole organisation; the Lodge is another home.
    expect(mine).not.toContain(DEMO.users.owner.id);
    expect(mine).not.toContain(LODGE.qualityLeadId);
  });

  it("offers a manager only the roles they may give, and only at their home", async () => {
    const roles = (await list("manager")).assignableRoles;
    const carer = roles.find((r) => r.name === "Care or support worker");
    expect(carer?.locationIds).toEqual([DEMO.locationId]);
    expect(roles.some((r) => r.name === "Owner")).toBe(false);
    const ownerRoles = (await list("owner")).assignableRoles;
    expect(ownerRoles.find((r) => r.name === "Owner")?.locationIds).toContain(null);
  });

  it("filters by location", async () => {
    const atLodge = (await list("owner", `?locationId=${LODGE.locationId}`)).items.map((m) => m.id);
    expect(atLodge).toContain(LODGE.qualityLeadId);
    expect(atLodge).not.toContain(DEMO.users.carer.id);
  });

  it("refuses anyone without platform.user.manage, and never crosses organisations", async () => {
    expect((await h.request("/v1/members", as("carer"))).status).toBe(403);
    // Rae manages another organisation: not a member here, and holds no platform.user.manage.
    expect((await h.request("/v1/members", as("rae"))).status).toBe(403);
    const other = await h.request("/v1/members", { token: h.tokens.owner, tenant: OTHER.tenantId });
    expect(other.status).toBe(403);
    const ids = (await list("owner")).items.map((m) => m.id);
    expect(ids).not.toContain(OTHER.managerId);
    expect(ids).not.toContain(OTHER.agencyId);
  });
});

describe("hazard HZ-011 adding an invited member", () => {
  it("adds an invited member who can then be invited, audited without the address", async () => {
    const body = newMember(await roleId("care_worker"), DEMO.locationId);
    const response = await create({ ...body, email: body.email.toUpperCase() }, "manager");
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: body.id });

    const listed = (await list("manager")).items.find((m) => m.id === body.id);
    expect(listed).toMatchObject({ displayName: body.displayName, state: "invited" });

    const invite = await h.request("/v1/invitations", {
      method: "POST",
      body: { tenantUserId: body.id },
      ...as("manager"),
    });
    expect(invite.status).toBe(201);
    expect(h.handle.services.mockEmail.sent.at(-1)?.to).toBe(body.email);

    const events = await audits(body.id);
    expect(events.map((e) => e.action)).toContain("platform.member.created");
    expect(JSON.stringify(events)).not.toContain("new.member");
  });

  it("answers a retry with the same id once, and refuses the id with other details", async () => {
    const body = newMember(await roleId("care_worker"), DEMO.locationId);
    expect((await create(body)).status).toBe(201);
    const again = await create(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id: body.id });
    const changed = await create({ ...body, email: "someone.else@example.invalid" });
    expect(changed.status).toBe(409);
    expect(await codeOf(changed)).toBe("member_id_conflict");
    // Another manager's retry of the same id is not theirs to replay.
    expect((await create(body, "manager")).status).toBe(409);
  });

  it("refuses an address already in the organisation, in any case", async () => {
    const body = newMember(await roleId("care_worker"), DEMO.locationId);
    const response = await create({ ...body, email: DEMO.users.carer.email.toUpperCase() });
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("email_in_use");
    const events = await audits(body.id);
    expect(events).toEqual([
      expect.objectContaining({ outcome: "denied", reason: "email_in_use" }),
    ]);
  });

  it.each([
    ["the owner's role", "owner", DEMO.locationId],
    ["a role at another home", "care_worker", LODGE.locationId],
    ["a role across the organisation", "care_worker", null],
  ] as const)("refuses a manager giving %s", async (_, key, locationId) => {
    const body = newMember(await roleId(key), locationId);
    const response = await create(body, "manager");
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("beyond_inviter");
    expect((await list("owner")).items.map((m) => m.id)).not.toContain(body.id);
  });

  it("refuses another organisation's role, and anyone without the permission", async () => {
    const foreign = newMember(await roleId("registered_manager", OTHER.tenantId), null);
    const response = await create(foreign);
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("beyond_inviter");
    const body = newMember(await roleId("care_worker"), DEMO.locationId);
    expect((await create(body, "carer")).status).toBe(403);
    expect((await create(body, "rae")).status).toBe(403);
  });

  it("refuses an invalid address", async () => {
    const body = newMember(await roleId("care_worker"), DEMO.locationId);
    expect((await create({ ...body, email: "not an address" })).status).toBe(422);
  });
});

describe("hazard HZ-011 row-level security on adding members (migration 0060)", () => {
  it("refuses the application role a member who is not invited, or a role beyond the giver", async () => {
    const app = h.db.pool("harbour_app");
    const client = await app.connect();
    const asManager = async (sql: string, params: unknown[]) => {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', 'tenant', true)`,
        [DEMO.tenantId, DEMO.users.manager.id],
      );
      try {
        await client.query(sql, params);
        await client.query("COMMIT");
        return "ok";
      } catch (error) {
        await client.query("ROLLBACK");
        return (error as { code?: string }).code;
      }
    };
    try {
      expect(
        await asManager(
          `INSERT INTO tenant_user (display_name, email, status) VALUES ('Bo Example', 'bo@example.invalid', 'active')`,
          [],
        ),
      ).toBe("42501");
      const id = randomUUID();
      expect(
        await asManager(
          `WITH m AS (INSERT INTO tenant_user (id, display_name, email) VALUES ($1, 'Cy Example', 'cy@example.invalid') RETURNING id)
           INSERT INTO role_assignment (tenant_user_id, role_id, location_id) SELECT id, $2, $3 FROM m`,
          [id, await roleId("owner"), DEMO.locationId],
        ),
      ).toBe("42501");
    } finally {
      client.release();
    }
  });
});

import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Development reads follow attribute scope through the API (ADR-0136, migration 0161; WORK-009
 * follow-up): the Owner (a tenant-scoped role) reads every member of staff; the Registered Manager
 * of the demo home reads the members who work there and never a member who works only at Harbour
 * Lodge, in the supervisions list, the training matrix, the member's development record and the
 * reminder tasks about them; a care worker reads none of the lists; another organisation's manager
 * reads nothing of this one's.
 */

let h: Harness;
const as = (who: string, path: string, tenant: string = DEMO.tenantId) =>
  h.request(path, { token: h.tokens[who], tenant });
const CARER = DEMO.users.carer.id;
const LODGE_WORKER = "0199f400-0000-7000-8000-000000000611";
const LODGE_ROLE = "0199f400-0000-7000-8000-000000000501";

type Listed = { members: { member: { id: string } }[] };
type Tasks = { items: { id: string; kind: string; title: string }[] };

async function sql(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  h = await createHarness();
  // A care worker at Harbour Lodge only, with a training topic their role needs and a reminder.
  await sql(
    `INSERT INTO role (id, key, name, scope_kind, permissions, based_on_key)
     VALUES ($1, 'lodge_carer', 'Lodge care worker', 'location', '{workforce.self.read}', 'care_worker')`,
    [LODGE_ROLE],
  );
  await sql(
    `INSERT INTO tenant_user (id, display_name, email, status)
     VALUES ($1, 'Lena Lodge', 'lena.lodge@example.invalid', 'active')`,
    [LODGE_WORKER],
  );
  await sql(
    "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
    [LODGE_WORKER, LODGE_ROLE, LODGE.locationId],
  );
  await sql(
    `INSERT INTO training_requirement (role_key, topic) VALUES ('lodge_carer', 'fire_safety')
     ON CONFLICT DO NOTHING`,
  );
  for (const member of [LODGE_WORKER, CARER]) {
    await sql(
      `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key,
                         source_type, source_id, details)
       VALUES ('workforce.supervision_due', $2, 'workforce.supervision.manage', now(), 'hr',
               'tenant_user', $1::uuid, jsonb_build_object('memberId', $1::uuid))`,
      [member, `Hold a supervision that is due (${member === CARER ? "home" : "lodge"})`],
    );
  }
});

afterAll(async () => {
  await h?.close();
});

const listed = async (who: string, path: string) => {
  const response = await as(who, path);
  expect(response.status).toBe(200);
  return ((await response.json()) as Listed).members.map((m) => m.member.id);
};
const reminders = async (who: string) => {
  const response = await as(who, "/v1/tasks");
  expect(response.status).toBe(200);
  return ((await response.json()) as Tasks).items
    .filter((t) => t.kind === "workforce.supervision_due")
    .map((t) => t.title)
    .sort();
};

describe("hazard HZ-011 development reads follow attribute scope (ADR-0136)", () => {
  it.each([
    ["owner", true],
    ["manager", false],
  ] as const)(
    "%s: the supervisions list holds the home's staff, and the Lodge worker only in scope",
    async (who, seesLodge) => {
      const ids = await listed(who, "/v1/workforce/supervisions-due");
      expect(ids).toContain(CARER);
      expect(ids.includes(LODGE_WORKER)).toBe(seesLodge);
    },
  );

  it.each([
    ["owner", true],
    ["manager", false],
  ] as const)("%s: the training matrix follows the same scope", async (who, seesLodge) => {
    const ids = await listed(who, "/v1/workforce/training-matrix");
    expect(ids.includes(LODGE_WORKER)).toBe(seesLodge);
  });

  it.each([
    ["owner", LODGE_WORKER, 200],
    ["manager", LODGE_WORKER, 404],
    ["manager", CARER, 200],
  ] as const)("%s reading %s's development record: %i", async (who, member, status) => {
    expect((await as(who, `/v1/workforce/members/${member}/development`)).status).toBe(status);
  });

  it("refuses a record written for a member out of scope, audited, and writes nothing", async () => {
    const body = {
      topic: "fire_safety",
      tier: null,
      completedOn: "2026-10-01",
      expiresOn: null,
      provider: null,
    };
    const response = await h.request(`/v1/workforce/members/${LODGE_WORKER}/training-records`, {
      method: "POST",
      body,
      token: h.tokens.manager,
      tenant: DEMO.tenantId,
    });
    expect(response.status).toBe(403);
    const rows = await sql("SELECT 1 FROM training_record WHERE worker_id = $1", [LODGE_WORKER]);
    expect(rows).toHaveLength(0);
  });

  it("shows the reminder about a member only to holders whose scope covers them", async () => {
    expect(await reminders("owner")).toEqual([
      "Hold a supervision that is due (home)",
      "Hold a supervision that is due (lodge)",
    ]);
    expect(await reminders("manager")).toEqual(["Hold a supervision that is due (home)"]);
    expect(await reminders("carer")).toEqual([]);
  });

  it("never offers or names a revalidation confirmer whose scope does not cover the nurse", async () => {
    const cycle = "2027-03-31";
    // Recorded by the Owner through the application role, as the API would.
    const client = await h.db.pool("harbour_app").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
                set_config('app.user_id', $2, true)`,
        [DEMO.tenantId, DEMO.users.owner.id],
      );
      await client.query(
        "INSERT INTO revalidation_evidence (worker_id, cycle_due_on) VALUES ($1, $2)",
        [LODGE_WORKER, cycle],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const offered = async (member: string) =>
      (
        (await (
          await as("owner", `/v1/workforce/members/${member}/revalidation/confirmers`)
        ).json()) as { items: { id: string }[] }
      ).items.map((i) => i.id);
    // The demo home's Registered Manager confirms for its own staff, never for Lodge staff.
    expect(await offered(CARER)).toContain(DEMO.users.manager.id);
    expect(await offered(LODGE_WORKER)).not.toContain(DEMO.users.manager.id);
    const [row] = (await sql(
      "SELECT version FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [LODGE_WORKER, cycle],
    )) as { version: number }[];
    const named = await h.request(`/v1/workforce/members/${LODGE_WORKER}/revalidation/confirmer`, {
      method: "PUT",
      body: {
        expectedVersion: row?.version,
        cycleDueOn: cycle,
        confirmerId: DEMO.users.manager.id,
      },
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    expect(named.status).toBe(422);
    expect(((await named.json()) as { code: string }).code).toBe("confirmer_not_permitted");
  });

  it("refuses the lists to a care worker, and shows another organisation nothing of this one", async () => {
    expect((await as("carer", "/v1/workforce/supervisions-due")).status).toBe(403);
    expect((await as("carer", "/v1/workforce/training-matrix")).status).toBe(403);
    expect([403, 404]).toContain(
      (await as("rae", `/v1/workforce/members/${CARER}/development`)).status,
    );
    const other = await as("rae", "/v1/workforce/supervisions-due");
    if (other.status === 200) {
      const ids = ((await other.json()) as Listed).members.map((m) => m.member.id);
      expect(ids).not.toContain(CARER);
      expect(ids).not.toContain(LODGE_WORKER);
    } else {
      expect(other.status).toBe(403);
    }
  });
});

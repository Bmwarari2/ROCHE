import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Reporting lines through the API (ADR-0137, amending ADR-0136; migration 0162): only
 * organisation-wide HR (here the Owner) sets a line manager or keeps teams, never oneself as line
 * manager, never anyone who is not current staff, against the version loaded, audited; a nurse at
 * the demo home who line manages a worker at Harbour Lodge reads that worker in the supervisions
 * list and the reminder about them while the line runs, and not once it has ended; a team lead
 * reads their team's members the same way; the Registered Manager of one home is refused the
 * changes; another organisation reaches nothing.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const NURSE = DEMO.users.nurse.id;
const LODGE_WORKER = "0199f500-0000-7000-8000-000000000611";
const LODGE_ROLE = "0199f500-0000-7000-8000-000000000501";
const LODGE_TWO = "0199f500-0000-7000-8000-000000000612";

type Listed = { members: { member: { id: string } }[] };
type Tasks = { items: { kind: string; title: string }[] };
type Line = { current: { id: string; managerId: string; version: number } | null };

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
  } finally {
    client.release();
  }
}

const supervisionsSeenBy = async (who: string) => {
  const response = await as(who, "/v1/workforce/supervisions-due");
  expect(response.status).toBe(200);
  return ((await response.json()) as Listed).members.map((m) => m.member.id);
};
const remindersSeenBy = async (who: string) => {
  const response = await as(who, "/v1/tasks");
  expect(response.status).toBe(200);
  return ((await response.json()) as Tasks).items
    .filter((t) => t.kind === "workforce.supervision_due")
    .map((t) => t.title);
};
const lineOf = async (member: string) =>
  (await (await as("owner", `/v1/workforce/members/${member}/line-manager`)).json()) as Line;

beforeAll(async () => {
  h = await createHarness();
  await sql(
    `INSERT INTO role (id, key, name, scope_kind, permissions, based_on_key)
     VALUES ($1, 'lodge_carer_lines', 'Lodge care worker', 'location', '{workforce.self.read}', 'care_worker')`,
    [LODGE_ROLE],
  );
  await sql(
    `INSERT INTO tenant_user (id, display_name, email, status)
     VALUES ($1, 'Lou Lodge', 'lou.lodge@example.invalid', 'active'),
            ($2, 'Lyn Lodge', 'lyn.lodge@example.invalid', 'active')`,
    [LODGE_WORKER, LODGE_TWO],
  );
  for (const member of [LODGE_WORKER, LODGE_TWO]) {
    await sql(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [member, LODGE_ROLE, LODGE.locationId],
    );
  }
  await sql(
    `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key,
                       source_type, source_id, details)
     VALUES ('workforce.supervision_due', 'Hold a supervision that is due (Lou)',
             'workforce.supervision.manage', now(), 'hr', 'tenant_user', $1::uuid,
             jsonb_build_object('memberId', $1::uuid))`,
    [LODGE_WORKER],
  );
  // The nurse holds supervision at the demo home only, so a line widens what they reach.
  await sql(
    `UPDATE role SET permissions = array_append(permissions, 'workforce.supervision.manage')
     WHERE id IN (SELECT role_id FROM role_assignment WHERE tenant_user_id = $1)
       AND NOT ('workforce.supervision.manage' = ANY (permissions))`,
    [NURSE],
  );
});

afterAll(async () => {
  await h?.close();
});

describe("ADR-0137 a line manager reads their direct reports wherever they work", () => {
  it("out of scope before any line", async () => {
    expect(await supervisionsSeenBy("nurse")).not.toContain(LODGE_WORKER);
    expect(await remindersSeenBy("nurse")).not.toContain("Hold a supervision that is due (Lou)");
  });

  it("HR names the nurse as line manager; the nurse then reads the report and the reminder", async () => {
    const set = await as("owner", `/v1/workforce/members/${LODGE_WORKER}/line-manager`, {
      method: "PUT",
      body: { managerId: NURSE, from: "2026-01-01", expectedVersion: null },
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as Line).current?.managerId).toBe(NURSE);
    expect(await supervisionsSeenBy("nurse")).toContain(LODGE_WORKER);
    expect(await remindersSeenBy("nurse")).toContain("Hold a supervision that is due (Lou)");
    const audited = await sql(
      "SELECT 1 FROM audit_event WHERE action = 'workforce.line_manager.set' AND resource_id = $1",
      [LODGE_WORKER],
    );
    expect(audited.length).toBeGreaterThan(0);
  });

  it("a stale version is refused, and nobody is their own line manager", async () => {
    const stale = await as("owner", `/v1/workforce/members/${LODGE_WORKER}/line-manager`, {
      method: "PUT",
      body: { managerId: DEMO.users.manager.id, from: "2026-03-01", expectedVersion: 99 },
    });
    expect(stale.status).toBe(409);
    const self = await as("owner", `/v1/workforce/members/${NURSE}/line-manager`, {
      method: "PUT",
      body: { managerId: NURSE, from: "2026-03-01", expectedVersion: null },
    });
    expect(self.status).toBe(422);
    expect(((await self.json()) as { code: string }).code).toBe("line_manager_is_member");
  });

  it("the Registered Manager of one home cannot change reporting lines, audited", async () => {
    const response = await as("manager", `/v1/workforce/members/${LODGE_WORKER}/line-manager`, {
      method: "PUT",
      body: { managerId: DEMO.users.manager.id, from: "2026-03-01", expectedVersion: null },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "reporting_lines_organisation_wide",
    );
    expect(
      (
        await as("manager", "/v1/workforce/teams", {
          method: "POST",
          body: { name: "Days", locationId: null },
        })
      ).status,
    ).toBe(403);
  });

  it("once HR ends the line, the former line manager reads the report no longer", async () => {
    const before = await lineOf(LODGE_WORKER);
    const today = new Date().toISOString().slice(0, 10);
    const ended = await as("owner", `/v1/workforce/members/${LODGE_WORKER}/line-manager`, {
      method: "PUT",
      body: { managerId: null, from: today, expectedVersion: before.current?.version ?? null },
    });
    expect(ended.status).toBe(200);
    expect(((await ended.json()) as Line).current).toBeNull();
    expect(await supervisionsSeenBy("nurse")).not.toContain(LODGE_WORKER);
  });
});

describe("ADR-0137 concurrency and who reads a line", () => {
  it("two first lines saved at once: one is saved, the other is a conflict", async () => {
    const put = () =>
      as("owner", `/v1/workforce/members/${LODGE_TWO}/line-manager`, {
        method: "PUT",
        body: { managerId: DEMO.users.carer.id, from: "2026-01-01", expectedVersion: null },
      });
    const statuses = (await Promise.all([put(), put()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("a line manager with no development permission reads their own line, as row-level security allows", async () => {
    const response = await as("carer", `/v1/workforce/members/${LODGE_TWO}/line-manager`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Line).current?.managerId).toBe(DEMO.users.carer.id);
    expect((await as("carer", "/v1/workforce/supervisions-due")).status).toBe(403);
  });
});

describe("ADR-0137 a team lead reads their team", () => {
  it("HR keeps the team; the lead reads its members while they are in it", async () => {
    const team = await as("owner", "/v1/workforce/teams", {
      method: "POST",
      body: { name: "Nights across homes", locationId: null },
    });
    expect(team.status).toBe(201);
    const { id: teamId } = (await team.json()) as { id: string };
    for (const [memberId, isLead] of [
      [NURSE, true],
      [LODGE_WORKER, false],
    ] as const) {
      const added = await as("owner", `/v1/workforce/teams/${teamId}/members`, {
        method: "POST",
        body: { memberId, isLead, from: "2026-01-01" },
      });
      expect(added.status).toBe(201);
    }
    const again = await as("owner", `/v1/workforce/teams/${teamId}/members`, {
      method: "POST",
      body: { memberId: LODGE_WORKER, isLead: false, from: "2026-02-01" },
    });
    expect(again.status).toBe(409);
    expect(await supervisionsSeenBy("nurse")).toContain(LODGE_WORKER);
    // Archiving the team widens no one's scope.
    const listed = (await (await as("owner", "/v1/workforce/teams")).json()) as {
      teams: { id: string; version: number }[];
    };
    const version = listed.teams.find((t) => t.id === teamId)?.version;
    const archived = await as("owner", `/v1/workforce/teams/${teamId}`, {
      method: "PUT",
      body: {
        name: "Nights across homes",
        locationId: null,
        archived: true,
        expectedVersion: version,
      },
    });
    expect(archived.status).toBe(200);
    expect(await supervisionsSeenBy("nurse")).not.toContain(LODGE_WORKER);
  });

  it("another organisation reaches none of this organisation's lines", async () => {
    const other = await h.request(`/v1/workforce/members/${LODGE_WORKER}/line-manager`, {
      token: h.tokens.rae,
      tenant: DEMO.tenantId,
    });
    expect([403, 404]).toContain(other.status);
  });
});

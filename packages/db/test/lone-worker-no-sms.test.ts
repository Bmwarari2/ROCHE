import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Migration 0145 (ADR-0132: no SMS at launch; HZ-125). Saved lone-worker routes lose 'sms'; a step
 * left with no way to reach people away from the app gains a phone notification. Other chains are
 * untouched, each change is audited, and a second run changes nothing.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const ROUTE = "scheduling.lone_worker.alarm";

let db: TestDatabase;

const asOwner = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);

async function rerun(): Promise<void> {
  const sql = readFileSync(`${DRIZZLE}0145_lone_worker_no_sms.sql`, "utf8");
  const client = await db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const step = (afterMinutes: number, channels: string[], role = "team_leader") => ({
  afterMinutes,
  targetRoleKey: role,
  channels,
});

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-125 no saved lone-worker route relies on text messages (migration 0145)", () => {
  it("removes text messages, gives an SMS-only step a phone notification, and audits once", async () => {
    await asOwner(TENANT_A, (c) =>
      c.query("INSERT INTO escalation_chain (key, name, steps) VALUES ($1, 'On call', $2)", [
        ROUTE,
        JSON.stringify([
          step(1, ["push", "sms"]),
          step(5, ["sms"]),
          step(10, ["in_app", "sms"]),
          step(15, ["email"], "registered_manager"),
        ]),
      ]),
    );
    // Another organisation's other chain keeps its text messages: only lone-worker routes change.
    await asOwner(TENANT_B, (c) =>
      c.query(
        "INSERT INTO escalation_chain (key, name, steps) VALUES ('missed_visit', 'Missed visit', $1)",
        [JSON.stringify([step(10, ["push", "sms"])])],
      ),
    );

    await rerun();

    const [route] = await asOwner(
      TENANT_A,
      async (c) =>
        (
          await c.query<{ steps: { channels: string[] }[] }>(
            "SELECT steps FROM escalation_chain WHERE key = $1",
            [ROUTE],
          )
        ).rows,
    );
    expect(route?.steps.map((s) => s.channels)).toEqual([
      ["push"],
      ["push"],
      ["in_app", "push"],
      ["email"],
    ]);
    const [other] = await asOwner(
      TENANT_B,
      async (c) =>
        (
          await c.query<{ steps: { channels: string[] }[] }>(
            "SELECT steps FROM escalation_chain WHERE key = 'missed_visit'",
          )
        ).rows,
    );
    expect(other?.steps[0]?.channels).toEqual(["push", "sms"]);

    const audit = async () =>
      asOwner(
        TENANT_A,
        async (c) =>
          (
            await c.query<{ scope: { steps: number } }>(
              "SELECT scope FROM audit_event WHERE action = 'scheduling.lone_worker.route_sms_removed'",
            )
          ).rows,
      );
    expect(await audit()).toEqual([{ scope: expect.objectContaining({ steps: 3 }) }]);

    // A second run finds nothing to change and audits nothing more.
    await rerun();
    expect(await audit()).toHaveLength(1);
  });

  it("leaves row-level security forced on escalation_chain", async () => {
    const forced = await db
      .pool("harbour_owner")
      .query<{ relforcerowsecurity: boolean }>(
        "SELECT relforcerowsecurity FROM pg_class WHERE oid = 'public.escalation_chain'::regclass",
      );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
  });
});

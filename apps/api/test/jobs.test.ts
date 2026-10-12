import { createDatabase, createPool } from "@harbour/db";
import { DEMO, seedDemoTenant } from "@harbour/db/seed";
import { createTestDatabase, type TestDatabase } from "@harbour/db/testing";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockEmail, MockPush, MockSms } from "../src/integrations/adapters";
import { createAdapterResolver } from "../src/integrations/registry";
import {
  endExpiredAssignments,
  processDeliveries,
  relayOutbox,
  runEscalations,
  type TaskDeps,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";

let db: TestDatabase;
let deps: TaskDeps;
let appPool: pg.Pool;

async function asTenant<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedDemoTenant(db.pool("harbour_owner"));
  appPool = createPool(db.url("harbour_app"));
  deps = {
    workerPool: db.pool("harbour_worker"),
    appDb: createDatabase(appPool),
    logger: createLogger("silent"),
  };
});

afterAll(async () => {
  await appPool?.end();
  await db?.drop();
});

describe("outbox relay", () => {
  it("delivers pending events once and marks them published", async () => {
    await asTenant(appPool, (c) =>
      c.query(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('person', 'p1', 'people.test_happened', '{}'), ('person', 'p2', 'people.unhandled', '{}')`,
      ),
    );
    const seen: string[] = [];
    const handlers = new Map([
      ["people.test_happened", async (e: { aggregateId: string }) => void seen.push(e.aggregateId)],
    ]);
    expect(await relayOutbox(deps, handlers)).toBe(2);
    expect(await relayOutbox(deps, handlers)).toBe(0);
    expect(seen).toEqual(["p1"]);
  });

  it("backs off a failing handler instead of losing the event", async () => {
    await asTenant(appPool, (c) =>
      c.query(
        `INSERT INTO outbox_event (aggregate_type, aggregate_id, event_type, payload)
         VALUES ('person', 'p3', 'people.flaky', '{}')`,
      ),
    );
    const handlers = new Map([
      [
        "people.flaky",
        async () => {
          throw new TypeError("downstream unavailable");
        },
      ],
    ]);
    await relayOutbox(deps, handlers);
    const { rows } = await db
      .pool("harbour_worker")
      .query(
        "SELECT attempts, last_error, published_at FROM outbox_event WHERE aggregate_id = 'p3'",
      );
    expect(rows[0]).toMatchObject({ attempts: 1, last_error: "TypeError", published_at: null });
  });
});

describe("escalation chains", () => {
  it("re-sends an unacknowledged alarm to the next role, then stops when acknowledged", async () => {
    const created = new Date("2026-10-11T08:00:00Z");
    await asTenant(appPool, async (c) => {
      // The Registered Manager has been in post since before the alarm: only a role in force when
      // a step fires is told (ADR-0071 review round 2).
      await c.query(
        "UPDATE role_assignment SET valid_from = '2026-01-01T00:00:00Z' WHERE tenant_user_id = $1",
        [DEMO.users.manager.id],
      );
      const chain = await c.query<{ id: string }>(
        `INSERT INTO escalation_chain (key, name, steps) VALUES ('missed_visit', 'Missed visit',
           '[{"afterMinutes":10,"targetRoleKey":"registered_manager","channels":["push"]},
             {"afterMinutes":20,"targetRoleKey":"owner","channels":["push","sms"]}]') RETURNING id`,
      );
      await c.query(
        `INSERT INTO notification (recipient_tenant_user_id, kind, severity, title, escalation_chain_id, escalate_at, created_at)
         VALUES ($1, 'scheduling.missed_visit', 'urgent', 'A visit was missed', $2, $3, $4)`,
        [
          DEMO.users.carer.id,
          chain.rows[0]?.id,
          new Date(created.getTime() + 10 * 60_000),
          created,
        ],
      );
    });

    expect(await runEscalations(deps, new Date("2026-10-11T08:05:00Z"))).toBe(0);
    expect(await runEscalations(deps, new Date("2026-10-11T08:11:00Z"))).toBe(1);
    const managerInbox = await asTenant(appPool, (c) =>
      c.query("SELECT title FROM notification WHERE recipient_tenant_user_id = $1", [
        DEMO.users.manager.id,
      ]),
    );
    expect(managerInbox.rows.map((r) => r.title)).toEqual(["Escalated: A visit was missed"]);

    await asTenant(appPool, (c) =>
      c.query(
        "UPDATE notification SET acknowledged_at = now() WHERE kind = 'scheduling.missed_visit' AND recipient_tenant_user_id = $1",
        [DEMO.users.carer.id],
      ),
    );
    expect(await runEscalations(deps, new Date("2026-10-11T08:30:00Z"))).toBe(0);
  });
});

describe("assignment expiry", () => {
  it("soft-deletes assignments whose end time has passed", async () => {
    await asTenant(appPool, (c) =>
      c.query(
        `UPDATE person_assignment SET valid_to = now() - interval '1 minute'
         WHERE tenant_user_id = $1 AND person_id = (SELECT id FROM person WHERE given_name = 'Cara')`,
        [DEMO.users.carer.id],
      ),
    );
    expect(await endExpiredAssignments(deps)).toBe(1);
    expect(await endExpiredAssignments(deps)).toBe(0);
  });
});

describe("notification deliveries", () => {
  it("emails the recipient a generic title and skips channels without a destination", async () => {
    const mocks = { email: new MockEmail(), sms: new MockSms(), push: new MockPush() };
    const adapterFor = createAdapterResolver({ production: false, mocks });
    await asTenant(appPool, (c) =>
      c.query(
        `INSERT INTO notification (recipient_tenant_user_id, kind, title, link, channels)
         VALUES ($1, 'test.delivery', 'A visit was missed', '/visits/1', '{in_app,email,push}')`,
        [DEMO.users.manager.id],
      ),
    );
    expect(await processDeliveries({ ...deps, adapterFor })).toBe(1);
    expect(mocks.email.sent).toEqual([
      expect.objectContaining({
        to: "manager@example.invalid",
        title: "A visit was missed",
        link: "/visits/1",
      }),
    ]);
    const statuses = await asTenant(appPool, (c) =>
      c.query(
        `SELECT d.channel, d.status FROM notification_delivery d
         JOIN notification n ON n.id = d.notification_id
         WHERE n.kind = 'test.delivery' ORDER BY d.channel`,
      ),
    );
    expect(statuses.rows).toEqual([
      { channel: "email", status: "sent" },
      { channel: "push", status: "skipped" },
    ]);
    expect(await processDeliveries({ ...deps, adapterFor })).toBe(0);
  });
});

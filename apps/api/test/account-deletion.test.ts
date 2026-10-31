import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * In-app account deletion request (MOB-011; master prompt 17.3; App Store guideline 5.1.1(v),
 * Google Play account deletion policy): any member may ask from the app; the request goes to the
 * care provider's Registered Manager as a task due within account_deletion.confirmation_days, with
 * a notification and an audit event. Nothing is deleted by it, and no care record ever is.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string, path: string, method = "GET") =>
  h.request(path, { token: h.tokens[who], tenant: DEMO.tenantId, method });

type Request = {
  status: "requested" | "already_requested";
  requestedAt: string;
  respondBy: string;
  routedToManager: boolean;
};

/** Reads as the owner role within the demo organisation. */
async function rows<R extends Record<string, unknown>>(text: string, values: unknown[]) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    return (await client.query<R>(text, values)).rows;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("account deletion request (MOB-011)", () => {
  it("routes a carer's request to the Registered Manager as a task due in 30 days, and deletes nothing", async () => {
    const first = await as("carer", "/v1/me/account-deletion-request", "POST");
    expect(first.status).toBe(201);
    const made = (await first.json()) as Request;
    expect(made).toMatchObject({ status: "requested", routedToManager: true });
    const days =
      (new Date(made.respondBy).getTime() - new Date(made.requestedAt).getTime()) / 86_400_000;
    // From the rate table (account_deletion.confirmation_days), never a literal in the code.
    const [rate] = await rows<{ value: string }>(
      "SELECT value::text FROM rate_table WHERE key = 'account_deletion.confirmation_days' LIMIT 1",
      [],
    );
    expect(Math.round(days)).toBe(Number(rate?.value));

    const tasks = await rows<{
      assignee_tenant_user_id: string;
      required_permission: string;
      source_id: string;
    }>(
      `SELECT assignee_tenant_user_id, required_permission, source_id FROM task
        WHERE kind = 'platform.account_deletion_request' AND status = 'open'`,
      [],
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      assignee_tenant_user_id: DEMO.users.manager.id,
      required_permission: "platform.user.manage",
      source_id: DEMO.users.carer.id,
    });
    const told = await rows<{ title: string; body: string }>(
      `SELECT title, body FROM notification
        WHERE kind = 'platform.account_deletion.requested' AND recipient_tenant_user_id = $1`,
      [DEMO.users.manager.id],
    );
    expect(told).toHaveLength(1);
    // Opaque: no name or address in the notification.
    expect(`${told[0]?.title} ${told[0]?.body}`).not.toContain("example.invalid");
    const audited = await rows<{ action: string }>(
      `SELECT action FROM audit_event
        WHERE action = 'platform.account_deletion.requested' AND resource_id = $1`,
      [DEMO.users.carer.id],
    );
    expect(audited).toHaveLength(1);

    // Nothing was deleted: the carer is still a member and still reads their people.
    expect((await as("carer", "/v1/me")).status).toBe(200);
    expect((await as("carer", "/v1/people")).status).toBe(200);
  });

  it("returns the open request when asked again, raising no second task", async () => {
    const again = await as("carer", "/v1/me/account-deletion-request", "POST");
    expect(again.status).toBe(200);
    expect(((await again.json()) as Request).status).toBe("already_requested");
    const open = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM task
        WHERE kind = 'platform.account_deletion_request' AND source_id = $1 AND status = 'open'`,
      [DEMO.users.carer.id],
    );
    expect(open[0]?.n).toBe(1);
  });

  it("never gives the Registered Manager's own request to themselves", async () => {
    const own = await as("manager", "/v1/me/account-deletion-request", "POST");
    expect(own.status).toBe(201);
    const [row] = await rows<{ assignee_tenant_user_id: string | null }>(
      `SELECT assignee_tenant_user_id FROM task
        WHERE kind = 'platform.account_deletion_request' AND source_id = $1`,
      [DEMO.users.manager.id],
    );
    expect(row?.assignee_tenant_user_id).not.toBe(DEMO.users.manager.id);
  });

  it("raises one task for two requests sent at once (a double tap)", async () => {
    const [a, b] = await Promise.all([
      as("nurse", "/v1/me/account-deletion-request", "POST"),
      as("nurse", "/v1/me/account-deletion-request", "POST"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const open = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM task
        WHERE kind = 'platform.account_deletion_request' AND source_id = $1`,
      [DEMO.users.nurse.id],
    );
    expect(open[0]?.n).toBe(1);
  });

  it("lets a member ask only a few times a day, so managers cannot be flooded", async () => {
    // The nurse has asked twice above; the limit is ACCOUNT_DELETION_REQUESTS_PER_DAY (3).
    expect((await as("nurse", "/v1/me/account-deletion-request", "POST")).status).toBe(200);
    const fourth = await as("nurse", "/v1/me/account-deletion-request", "POST");
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).not.toBeNull();
  });

  it("needs a signed-in member", async () => {
    const anonymous = await h.request("/v1/me/account-deletion-request", {
      method: "POST",
      tenant: DEMO.tenantId,
    });
    expect(anonymous.status).toBe(401);
  });
});

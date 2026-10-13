import { DEVICE_HEADER } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER, PASSWORD } from "./support/harness";

/**
 * PLAT-003 and PLAT-004 follow-ups: `/v1/me` evaluates flags through the OpenFeature provider;
 * browser sessions are signed out after their role's idle timeout from the rate table, mobile
 * sessions never (HZ-110); a manager signs a member of staff out of every device.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function asTenant(sql: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

const auth = () => h.db.pool("harbour_auth");

type Member = "owner" | "manager" | "carer";

/**
 * A new sign-in from the web app: the session cookie a browser holds. Two-factor sign-in is
 * switched off for the moment it takes, then back on.
 */
async function browserSignIn(who: Member): Promise<{ cookie: string; token: string }> {
  const { email } = DEMO.users[who];
  await auth().query("UPDATE auth.user SET two_factor_enabled = false WHERE email = $1", [email]);
  try {
    const response = await h.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: PASSWORD },
      origin: "http://localhost:3000",
    });
    expect(response.status).toBe(200);
    const set = response.headers.getSetCookie().find((c) => c.startsWith("harbour.session_token="));
    const value = set?.split(";")[0]?.slice("harbour.session_token=".length) ?? "";
    expect(value).not.toBe("");
    return { cookie: `harbour.session_token=${value}`, token: decodeURIComponent(value) };
  } finally {
    await auth().query("UPDATE auth.user SET two_factor_enabled = true WHERE email = $1", [email]);
  }
}

const rawToken = (token: string) => token.split(".")[0];

async function idleFor(token: string, minutes: number) {
  await auth().query(
    "UPDATE auth.session SET updated_at = now() - make_interval(mins => $2) WHERE token = $1",
    [rawToken(token), minutes],
  );
}

const sessionExists = async (token: string) =>
  (await auth().query("SELECT 1 FROM auth.session WHERE token = $1", [rawToken(token)]))
    .rowCount === 1;

const me = (session: { cookie: string } | { token: string }) =>
  h.request("/v1/me", {
    tenant: DEMO.tenantId,
    ...("cookie" in session ? { headers: { cookie: session.cookie } } : { token: session.token }),
  });

describe("flags through the OpenFeature provider (PLAT-003)", () => {
  it("leaves out an override that was deleted", async () => {
    await asTenant(
      "INSERT INTO feature_flag (flag_key, enabled, deleted_at) VALUES ('module.finance', true, now())",
    );
    const before = (await (await me({ token: h.tokens.carer ?? "" })).json()) as {
      flags: Record<string, boolean>;
    };
    expect(before.flags["module.finance"]).toBe(false);
    expect(before.flags["module.ai"]).toBe(false);
    await asTenant("UPDATE feature_flag SET deleted_at = NULL WHERE flag_key = 'module.finance'");
    const after = (await (await me({ token: h.tokens.carer ?? "" })).json()) as {
      flags: Record<string, boolean>;
    };
    expect(after.flags["module.finance"]).toBe(true);
    await asTenant("DELETE FROM feature_flag WHERE flag_key = 'module.finance'");
  });
});

describe("hazard HZ-110 idle timeouts per role (section 5.3)", () => {
  it("signs out a browser session idle past its role's timeout, and audits it", async () => {
    const carer = await browserSignIn("carer");
    expect((await me(carer)).status).toBe(200);
    // Within the care worker's 30 minutes: still signed in, and the use is recorded.
    await idleFor(carer.token, 20);
    expect((await me(carer)).status).toBe(200);
    const touched = await auth().query<{ fresh: boolean }>(
      "SELECT now() - updated_at < interval '1 minute' AS fresh FROM auth.session WHERE token = $1",
      [rawToken(carer.token)],
    );
    expect(touched.rows[0]?.fresh).toBe(true);
    await idleFor(carer.token, 31);
    const response = await me(carer);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("unauthenticated");
    expect(await sessionExists(carer.token)).toBe(false);
    const audits = await asTenant(
      `SELECT actor_tenant_user_id, scope FROM audit_event
       WHERE action = 'platform.session.idle_timeout' ORDER BY seq DESC LIMIT 1`,
    );
    expect(audits[0]).toMatchObject({
      actor_tenant_user_id: DEMO.users.carer.id,
      scope: { idleTimeoutMinutes: 30 },
    });
  });

  it("gives each role its own timeout, the organisation's override first", async () => {
    // The owner's row is 15 minutes (rates.md).
    const owner = await browserSignIn("owner");
    await idleFor(owner.token, 20);
    expect((await me(owner)).status).toBe(401);
    await asTenant(
      `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
       VALUES ($1, 'session.idle_timeout_minutes.care_worker', 10, 'minutes', 'all', '2000-01-01', 'test', 'tenant')`,
      [DEMO.tenantId],
    );
    try {
      const carer = await browserSignIn("carer");
      await idleFor(carer.token, 15);
      expect((await me(carer)).status).toBe(401);
    } finally {
      await asTenant(
        "DELETE FROM rate_table WHERE key = 'session.idle_timeout_minutes.care_worker'",
      );
    }
  });

  it("never signs out the mobile app's session, which the device lock covers", async () => {
    const carer = await browserSignIn("carer");
    await idleFor(carer.token, 6 * 60);
    expect((await me({ token: carer.token })).status).toBe(200);
    expect(await sessionExists(carer.token)).toBe(true);
  });

  it("moves a session's expiry on without counting the refresh as use", async () => {
    const carer = await browserSignIn("carer");
    // Last refreshed two hours ago, so the hourly refresh is due, and idle for 31 minutes.
    const age = (token: string) =>
      auth().query(
        `UPDATE auth.session SET expires_at = now() + interval '10 hours',
           updated_at = now() - interval '31 minutes' WHERE token = $1`,
        [rawToken(token)],
      );
    await age(carer.token);
    const devices = await h.request("/v1/me/sessions", { headers: { cookie: carer.cookie } });
    expect(devices.status).toBe(200);
    const after = await auth().query<{ slid: boolean; idle: boolean }>(
      `SELECT expires_at > now() + interval '11 hours' AS slid,
         updated_at < now() - interval '30 minutes' AS idle FROM auth.session WHERE token = $1`,
      [rawToken(carer.token)],
    );
    expect(after.rows[0]).toEqual({ slid: true, idle: true });
    await age(carer.token);
    expect((await me(carer)).status).toBe(401);
  });
});

describe("a manager signs a member of staff out of every device", () => {
  const revoke = (token: string, member: string, body: Record<string, unknown> = {}) =>
    h.request(`/v1/members/${member}/sessions/revoke`, {
      method: "POST",
      token,
      tenant: DEMO.tenantId,
      body: { reasonCode: "lost_or_stolen_device", ...body },
    });

  it("needs platform.user.manage and a fresh sign-in", async () => {
    expect((await revoke(h.tokens.carer ?? "", DEMO.users.nurse.id)).status).toBe(403);
    const manager = await browserSignIn("manager");
    await auth().query(
      "UPDATE auth.session SET created_at = now() - interval '1 hour' WHERE token = $1",
      [rawToken(manager.token)],
    );
    const stale = await revoke(manager.token, DEMO.users.carer.id);
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe("step_up_required");
    const refused = await asTenant(
      `SELECT 1 FROM audit_event WHERE action = 'platform.session.revoked_for_member'
       AND outcome = 'denied' AND reason = 'step_up_required'`,
    );
    expect(refused).toHaveLength(1);
  });

  it("reaches only members wholly at the manager's homes", async () => {
    const manager = await browserSignIn("manager");
    for (const member of [DEMO.users.owner.id, LODGE.qualityLeadId, OTHER.managerId]) {
      expect((await revoke(manager.token, member)).status, member).toBe(404);
    }
    // The owner reaches another organisation's member no more than the manager does.
    const owner = await browserSignIn("owner");
    expect((await revoke(owner.token, OTHER.managerId)).status).toBe(404);
  });

  it("asks before signing out a member whose device holds entries, then signs out every session", async () => {
    const carer = await browserSignIn("carer");
    const device = "0199d000-0000-4000-8000-0000000d0001";
    const report = await h.request("/v1/sync/device-report", {
      method: "POST",
      token: carer.token,
      tenant: DEMO.tenantId,
      headers: { [DEVICE_HEADER]: device },
      body: {
        unsent: 0,
        refused: 0,
        held: 2,
        blocked: 0,
        oldestAgeSeconds: null,
        reportedAt: new Date().toISOString(),
      },
    });
    expect(report.status).toBeLessThan(300);
    const manager = await browserSignIn("manager");
    const unconfirmed = await revoke(manager.token, DEMO.users.carer.id);
    expect(unconfirmed.status).toBe(409);
    expect(((await unconfirmed.json()) as { code: string }).code).toBe("entries_waiting");
    expect(await sessionExists(carer.token)).toBe(true);

    const done = await revoke(manager.token, DEMO.users.carer.id, { confirmEntriesWaiting: true });
    expect(done.status).toBe(200);
    const result = (await done.json()) as { revoked: number; entriesWaiting: number };
    expect(result.revoked).toBeGreaterThanOrEqual(2);
    expect(result.entriesWaiting).toBeGreaterThan(0);
    expect(await sessionExists(carer.token)).toBe(false);
    expect((await me({ token: carer.token })).status).toBe(401);
    const audits = await asTenant(
      `SELECT actor_tenant_user_id, resource_id, reason, scope FROM audit_event
       WHERE action = 'platform.session.revoked_for_member' AND outcome = 'success'`,
    );
    expect(audits).toEqual([
      {
        actor_tenant_user_id: DEMO.users.manager.id,
        resource_id: DEMO.users.carer.id,
        reason: "lost_or_stolen_device",
        scope: {
          reasonCode: "lost_or_stolen_device",
          revoked: result.revoked,
          entriesWaiting: result.entriesWaiting,
        },
      },
    ]);
  });
});

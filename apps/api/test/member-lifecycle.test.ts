import { DEVICE_HEADER } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepSignInErasures } from "../src/services/member-lifecycle";
import {
  ageSession,
  createHarness,
  type Harness,
  markSessionsVerified,
  OTHER,
  PASSWORD,
} from "./support/harness";

/**
 * The member lifecycle (H-566; platform.md, Members): a holder of platform.user.manage, with
 * step-up and a coded reason, suspends a membership, then ends it once the member's held entries
 * are handed over; the member row, display name and job title stay so care records remain
 * attributable; once the person asked for deletion and has no active membership anywhere, their
 * sign-in identity is erased and the request closes with its outcome.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function inTenant<R extends Record<string, unknown>>(
  tenantId: string,
  text: string,
  values: unknown[] = [],
) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId],
    );
    const result = await client.query<R>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}
const asDemo = <R extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  inTenant<R>(DEMO.tenantId, text, values);

const auth = () => h.db.pool("harbour_auth");

/** A fresh sign-in from the web app (two-factor switched off for the moment it takes). */
async function signIn(email: string): Promise<string> {
  await auth().query("UPDATE auth.user SET two_factor_enabled = false WHERE email = $1", [email]);
  try {
    const response = await h.request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: PASSWORD },
      origin: "http://localhost:3000",
    });
    if (response.status !== 200) return "";
    const set = response.headers.getSetCookie().find((c) => c.startsWith("harbour.session_token="));
    return decodeURIComponent(set?.split(";")[0]?.slice("harbour.session_token=".length) ?? "");
  } finally {
    await auth().query("UPDATE auth.user SET two_factor_enabled = true WHERE email = $1", [email]);
    await markSessionsVerified(auth());
  }
}

const post = (token: string, path: string, body: Record<string, unknown>, tenant = DEMO.tenantId) =>
  h.request(path, { method: "POST", token, tenant, body });
const suspend = (token: string, member: string, body: Record<string, unknown> = {}) =>
  post(token, `/v1/members/${member}/suspend`, { reasonCode: "leaving", ...body });
const end = (token: string, member: string) =>
  post(token, `/v1/members/${member}/end`, { reasonCode: "left_employment" });
const lifecycle = (token: string, member: string) =>
  h.request(`/v1/members/${member}/lifecycle`, { token, tenant: DEMO.tenantId });
const audits = (action: string, member: string, outcome = "success") =>
  asDemo<{ reason: string; scope: Record<string, unknown> }>(
    `SELECT reason, scope FROM audit_event WHERE action = $1 AND resource_id = $2 AND outcome = $3
      ORDER BY seq`,
    [action, member, outcome],
  );
const json = async <T>(response: Response) => (await response.json()) as T;

describe("H-566 suspending and ending a membership", () => {
  it("needs platform.user.manage and a fresh sign-in, audited", async () => {
    expect((await suspend(h.tokens.carer ?? "", DEMO.users.nurse.id)).status).toBe(403);
    const manager = await signIn(DEMO.users.manager.email);
    await ageSession(auth(), manager.split(".")[0] ?? "", 3600);
    const stale = await suspend(manager, DEMO.users.carer.id);
    expect(stale.status).toBe(403);
    expect((await json<{ code: string }>(stale)).code).toBe("step_up_required");
    const refusals = await asDemo(
      "SELECT 1 FROM audit_event WHERE action = 'platform.member.suspended' AND reason = 'step_up_required'",
    );
    expect(refusals).toHaveLength(1);
  });

  it("refuses another organisation's member as not found (cross-tenant), audited", async () => {
    const owner = await signIn(DEMO.users.owner.email);
    for (const call of [suspend(owner, OTHER.managerId), end(owner, OTHER.managerId)]) {
      expect((await call).status).toBe(404);
    }
    expect((await lifecycle(owner, OTHER.managerId)).status).toBe(404);
    expect(await audits("platform.member.suspended", OTHER.managerId, "denied")).toMatchObject([
      { reason: "not_found_or_out_of_scope" },
    ]);
    const [other] = await inTenant<{ status: string }>(
      OTHER.tenantId,
      "SELECT status FROM tenant_user WHERE id = $1",
      [OTHER.managerId],
    );
    expect(other?.status).toBe("active");
  });

  it("never changes the manager's own membership", async () => {
    const owner = await signIn(DEMO.users.owner.email);
    const own = await suspend(owner, DEMO.users.owner.id);
    expect(own.status).toBe(409);
    expect((await json<{ code: string }>(own)).code).toBe("own_membership");
  });

  it("suspends a carer: sign-in refused, Care mode stops, held entries chased, then ended and erased", async () => {
    const carer = await signIn(DEMO.users.carer.email);
    const device = "0199d000-0000-4000-8000-0000000e0566";
    const report = await h.request("/v1/sync/device-report", {
      method: "POST",
      token: carer,
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
    const asked = await post(carer, "/v1/me/account-deletion-request", {});
    expect(asked.status).toBe(201);
    const [{ n: attributed } = { n: "0" }] = await asDemo<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_event WHERE actor_tenant_user_id = $1",
      [DEMO.users.carer.id],
    );

    const manager = await signIn(DEMO.users.manager.email);
    const unconfirmed = await suspend(manager, DEMO.users.carer.id);
    expect(unconfirmed.status).toBe(409);
    expect((await json<{ code: string }>(unconfirmed)).code).toBe("entries_waiting");
    expect(await audits("platform.member.suspended", DEMO.users.carer.id, "denied")).toMatchObject([
      { reason: "entries_waiting" },
    ]);

    const done = await suspend(manager, DEMO.users.carer.id, { confirmEntriesWaiting: true });
    expect(done.status).toBe(200);
    expect(await json(done)).toMatchObject({
      state: "suspended",
      replay: false,
      signIn: "kept",
      entriesWaiting: 2,
    });
    // Every session of the sign-in ended; a new sign-in reaches the organisation no more.
    expect((await h.request("/v1/me", { token: carer, tenant: DEMO.tenantId })).status).toBe(401);
    const again = await signIn(DEMO.users.carer.email);
    const refused = await h.request("/v1/me", { token: again, tenant: DEMO.tenantId });
    expect(refused.status).toBe(403);
    expect((await json<{ code: string }>(refused)).code).toBe("not_a_member");
    // Care mode: the sync token is refused as not a member, so the phone ends the session.
    const sync = await h.request("/v1/sync/token", {
      method: "POST",
      token: again,
      tenant: DEMO.tenantId,
      headers: { [DEVICE_HEADER]: device },
    });
    expect(sync.status).toBe(403);
    expect((await json<{ code: string }>(sync)).code).toBe("not_a_member");
    // The device is not revoked (other staff may share it); its hold falls due at once.
    const bindings = await asDemo(
      "SELECT 1 FROM device_binding WHERE device_id = $1 AND revoked_at IS NOT NULL",
      [device],
    );
    expect(bindings).toHaveLength(0);
    const moved = await asDemo(
      "SELECT 1 FROM audit_event WHERE action = 'sync.device_hold.moved' AND scope ->> 'deviceId' = $1",
      [device],
    );
    expect(moved.length).toBeGreaterThan(0);

    // A replay changes nothing.
    const replay = await suspend(manager, DEMO.users.carer.id, { confirmEntriesWaiting: true });
    expect(await json(replay)).toMatchObject({ state: "suspended", replay: true });

    // Ending waits until the entries are handed over.
    const early = await end(manager, DEMO.users.carer.id);
    expect(early.status).toBe(409);
    expect((await json<{ code: string }>(early)).code).toBe("entries_to_hand_over");
    const status = await json<{ entriesToHandOver: number; deletionRequestOpen: boolean }>(
      await lifecycle(manager, DEMO.users.carer.id),
    );
    expect(status).toMatchObject({ entriesToHandOver: 2, deletionRequestOpen: true });
    // A hand-over closes the hold (as `closeTasks` does after the report that sends them).
    await asDemo(
      `UPDATE task SET status = 'done', status_reason = 'handed_over', completed_at = now()
        WHERE kind = 'sync.device_hold' AND source_id = $1`,
      [device],
    );

    const ended = await end(manager, DEMO.users.carer.id);
    expect(ended.status).toBe(200);
    expect(await json(ended)).toMatchObject({
      state: "left",
      replay: false,
      signIn: "erased",
      deletionRequestClosed: true,
    });
    // The sign-in identity is gone: user, sessions, password, passkeys and second factor.
    const authId = h.authIds.carer;
    for (const table of ["user", "session", "account", "two_factor", "passkey"]) {
      const column = table === "user" ? "id" : "user_id";
      const left = await auth().query(`SELECT 1 FROM auth."${table}" WHERE ${column} = $1`, [
        authId,
      ]);
      expect(left.rowCount, table).toBe(0);
    }
    // The member row, display name and job title stay: care records remain attributable.
    const [row] = await asDemo<{
      display_name: string;
      status: string;
      auth_user_id: string | null;
      email: string;
      sign_in_erased_at: Date | null;
    }>(
      "SELECT display_name, status, auth_user_id, email, sign_in_erased_at FROM tenant_user WHERE id = $1",
      [DEMO.users.carer.id],
    );
    expect(row).toMatchObject({
      display_name: DEMO.users.carer.name,
      status: "left",
      auth_user_id: null,
      email: `${DEMO.users.carer.id}@erased.invalid`,
    });
    expect(row?.sign_in_erased_at).not.toBeNull();
    const [{ n: still } = { n: "" }] = await asDemo<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_event WHERE actor_tenant_user_id = $1",
      [DEMO.users.carer.id],
    );
    expect(Number(still)).toBeGreaterThanOrEqual(Number(attributed));
    const [request] = await asDemo<{ status: string; status_reason: string }>(
      "SELECT status, status_reason FROM task WHERE kind = 'platform.account_deletion_request' AND source_id = $1",
      [DEMO.users.carer.id],
    );
    expect(request).toEqual({ status: "done", status_reason: "sign_in_erased" });
    expect(await audits("platform.member.ended", DEMO.users.carer.id)).toHaveLength(1);
    expect(await audits("platform.member.sign_in_erased", DEMO.users.carer.id)).toHaveLength(1);
    expect(await signIn(DEMO.users.carer.email)).toBe("");

    // Idempotent: ending again changes nothing.
    const replayEnd = await end(manager, DEMO.users.carer.id);
    expect(replayEnd.status).toBe(200);
    expect(await json(replayEnd)).toMatchObject({ state: "left", replay: true, signIn: "erased" });
    expect(await audits("platform.member.sign_in_erased", DEMO.users.carer.id)).toHaveLength(1);
  });

  it("keeps a member of two organisations working in the other, and erases once that ends too", async () => {
    const [agency] = await asDemo<{ id: string; auth_user_id: string }>(
      "SELECT id, auth_user_id FROM tenant_user WHERE email = 'agency@example.invalid'",
    );
    const agencyId = agency?.id ?? "";
    const asked = await post(h.tokens.agency ?? "", "/v1/me/account-deletion-request", {});
    expect(asked.status).toBe(201);
    const owner = await signIn(DEMO.users.owner.email);
    const suspended = await suspend(owner, agencyId);
    expect(suspended.status).toBe(200);
    expect(await json(suspended)).toMatchObject({
      sessionsEnded: 0,
      signIn: "kept_other_organisation",
    });
    // Still working for the other organisation; refused here.
    const there = await h.request("/v1/me", {
      token: h.tokens.agency ?? "",
      tenant: OTHER.tenantId,
    });
    expect(there.status).toBe(200);
    const here = await h.request("/v1/me", { token: h.tokens.agency ?? "", tenant: DEMO.tenantId });
    expect(here.status).toBe(403);

    const ended = await end(owner, agencyId);
    expect(await json(ended)).toMatchObject({
      state: "left",
      signIn: "kept_other_organisation",
      deletionRequestClosed: true,
    });
    const [request] = await asDemo<{ status_reason: string }>(
      "SELECT status_reason FROM task WHERE kind = 'platform.account_deletion_request' AND source_id = $1",
      [agencyId],
    );
    expect(request?.status_reason).toBe("membership_ended_sign_in_kept");
    const kept = await auth().query('SELECT 1 FROM auth."user" WHERE id = $1', [
      agency?.auth_user_id,
    ]);
    expect(kept.rowCount).toBe(1);
    const services = h.handle.services;
    const sweep = {
      workerPool: h.db.pool("harbour_worker"),
      appPool: services.appPool,
      appDb: services.db,
      authPool: services.authPool,
    };
    // Erasure happens only once no membership anywhere is active.
    expect(await sweepSignInErasures(sweep)).toBe(0);
    await inTenant(OTHER.tenantId, "UPDATE tenant_user SET status = 'left' WHERE id = $1", [
      OTHER.agencyId,
    ]);
    expect(await sweepSignInErasures(sweep)).toBe(1);
    const gone = await auth().query('SELECT 1 FROM auth."user" WHERE id = $1', [
      agency?.auth_user_id,
    ]);
    expect(gone.rowCount).toBe(0);
    expect(await sweepSignInErasures(sweep)).toBe(0);
    const [other] = await inTenant<{ auth_user_id: string | null; display_name: string }>(
      OTHER.tenantId,
      "SELECT auth_user_id, display_name FROM tenant_user WHERE id = $1",
      [OTHER.agencyId],
    );
    expect(other).toEqual({ auth_user_id: null, display_name: "Agency Ash" });
  });

  it("shows a member's status to a manager it reaches, with no address", async () => {
    const owner = await signIn(DEMO.users.owner.email);
    const response = await lifecycle(owner, DEMO.users.nurse.id);
    expect(response.status).toBe(200);
    const body = await json<Record<string, unknown>>(response);
    expect(body).toMatchObject({ state: "active", signIn: "kept", deletionRequestOpen: false });
    expect(JSON.stringify(body)).not.toContain("@");
  });
});

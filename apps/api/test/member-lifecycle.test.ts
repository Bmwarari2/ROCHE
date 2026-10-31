import { randomUUID } from "node:crypto";
import { DEVICE_HEADER, MEMBER_CHANGE_REASONS } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { MEMBERSHIP_CHANGE_REASONS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import {
  ageSession,
  createHarness,
  type Harness,
  LODGE,
  markSessionsVerified,
  OTHER,
  PASSWORD,
} from "./support/harness";

/**
 * Suspending and ending a membership and erasing the sign-in (platform.md, Members; recommended
 * answer to H-566; hazard HZ-011): platform.user.manage with step-up and a coded reason, only for
 * members that permission reaches, never one's own; suspend first, then end; the sign-in is
 * erased only once nobody else in Harbour relies on it, the member row stays so care records stay
 * attributable, and an open account deletion request closes. Invented people only.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const auth = () => h.db.pool("harbour_auth");

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  tenantId: string = DEMO.tenantId,
  userId = "",
): Promise<T[]> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
              set_config('app.user_id', $2, true)`,
      [tenantId, userId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A new member of staff with a sign-in, a care worker at the demo home, and a bearer token. */
async function newMember(
  given: string,
): Promise<{ id: string; authUserId: string; token: string }> {
  const email = `${given.toLowerCase()}.${randomUUID().slice(0, 8)}@example.invalid`;
  const name = `${given} Example`;
  const signUp = await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name },
  });
  expect(signUp.status).toBe(200);
  const authUserId = ((await signUp.json()) as { user: { id: string } }).user.id;
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  const token = signIn.headers.get("set-auth-token") ?? "";
  expect(token).not.toBe("");
  // An enrolled authenticator, as the harness gives staff (MFA guards care records).
  await auth().query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [authUserId]);
  await markSessionsVerified(auth());
  const id = randomUUID();
  await sql(
    `INSERT INTO tenant_user (id, display_name, email, job_title, status, auth_user_id)
     VALUES ($1, $2, $3, 'Care worker', 'active', $4)`,
    [id, name, email, authUserId],
  );
  await sql(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $2 FROM role WHERE key = 'care_worker'`,
    [id, DEMO.locationId],
  );
  return { id, authUserId, token };
}

const post = (who: string, path: string, body?: unknown) =>
  h.request(path, {
    method: "POST",
    token: h.tokens[who],
    tenant: DEMO.tenantId,
    ...(body === undefined ? {} : { body }),
  });
const suspend = (who: string, member: string, body: Record<string, unknown> = {}) =>
  post(who, `/v1/members/${member}/suspend`, { reasonCode: "staff_left", ...body });
const end = (who: string, member: string) =>
  post(who, `/v1/members/${member}/end`, { reasonCode: "staff_left" });
const erase = (who: string, member: string) => post(who, `/v1/members/${member}/sign-in/erase`);
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

const audits = (action: string, resourceId: string, tenantId: string = DEMO.tenantId) =>
  sql<{ outcome: string; reason: string | null; scope: Record<string, unknown> }>(
    "SELECT outcome, reason, scope FROM audit_event WHERE action = $1 AND resource_id = $2 ORDER BY seq",
    [action, resourceId],
    tenantId,
  );
const stateOf = async (id: string) =>
  (
    await sql<{ status: string; auth_user_id: string | null; display_name: string }>(
      "SELECT status, auth_user_id, display_name FROM tenant_user WHERE id = $1",
      [id],
    )
  )[0];

describe("H-566 the contract's reason codes are the domain's", () => {
  it("lists the same codes", () => {
    expect([...MEMBER_CHANGE_REASONS]).toEqual([...MEMBERSHIP_CHANGE_REASONS]);
  });
});

describe("hazard HZ-011 who may change a membership", () => {
  it("refuses anyone without platform.user.manage", async () => {
    expect((await suspend("carer", DEMO.users.nurse.id)).status).toBe(403);
    expect((await end("carer", DEMO.users.nurse.id)).status).toBe(403);
    expect((await erase("carer", DEMO.users.nurse.id)).status).toBe(403);
  });

  it("needs a fresh sign-in", async () => {
    const fay = await newMember("Fay");
    await ageSession(auth(), h.tokens.manager?.split(".")[0] ?? "", 3600);
    try {
      const stale = await suspend("manager", fay.id);
      expect(stale.status).toBe(403);
      expect(await codeOf(stale)).toBe("step_up_required");
      expect((await stateOf(fay.id))?.status).toBe("active");
    } finally {
      await ageSession(auth(), h.tokens.manager?.split(".")[0] ?? "", 0);
    }
  });

  it("reaches only members wholly at the manager's homes, never another organisation's, and audits the refusal", async () => {
    for (const member of [DEMO.users.owner.id, LODGE.qualityLeadId, OTHER.managerId]) {
      for (const response of [
        await suspend("manager", member),
        await end("manager", member),
        await erase("manager", member),
      ]) {
        expect(response.status, member).toBe(404);
      }
      expect(
        (await audits("platform.member.suspended", member)).map((a) => a.reason),
        member,
      ).toEqual(["not_found_or_out_of_scope"]);
    }
    // The owner reaches another organisation's member no more than the manager does.
    expect((await suspend("owner", OTHER.managerId)).status).toBe(404);
    expect((await stateOf(DEMO.users.owner.id))?.status).toBe("active");
  });

  it("never lets a manager change their own membership", async () => {
    const response = await suspend("manager", DEMO.users.manager.id);
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("own_membership");
    expect((await stateOf(DEMO.users.manager.id))?.status).toBe("active");
  });
});

describe("H-566 suspend, end, then erase the sign-in", () => {
  it("suspends first, ends, erases the sign-in, keeps care records attributable and closes the deletion request", async () => {
    const gil = await newMember("Gil");
    // A care note Gil wrote, and Gil's own request to delete the account.
    const [note] = await sql<{ id: string }>(
      `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
       SELECT id, location_id, 'visit', 'Ate well at lunch.', now() FROM person
        WHERE location_id = $1 ORDER BY id LIMIT 1 RETURNING id`,
      [DEMO.locationId],
      DEMO.tenantId,
      gil.id,
    );
    const requested = await h.request("/v1/me/account-deletion-request", {
      method: "POST",
      token: gil.token,
      tenant: DEMO.tenantId,
    });
    expect(requested.status).toBeLessThan(300);
    // Gil's sign-in has a passkey and an authenticator, as staff sign-ins do.
    await auth().query(
      `INSERT INTO auth.passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
       VALUES ($1, 'example-key', $2, $3, 0, 'singleDevice', false)`,
      [randomUUID(), gil.authUserId, randomUUID()],
    );
    await auth().query(
      `INSERT INTO auth.two_factor (id, secret, backup_codes, user_id) VALUES ($1, 'example', '[]', $2)`,
      [randomUUID(), gil.authUserId],
    );

    // Ending before suspending, or erasing before ending, is refused.
    const early = await end("manager", gil.id);
    expect(early.status).toBe(409);
    expect(await codeOf(early)).toBe("suspend_first");
    const tooSoon = await erase("manager", gil.id);
    expect(tooSoon.status).toBe(409);
    expect(await codeOf(tooSoon)).toBe("membership_not_ended");

    const suspended = await suspend("manager", gil.id);
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({
      tenantUserId: gil.id,
      state: "suspended",
      replay: false,
    });
    expect((await stateOf(gil.id))?.status).toBe("suspended");
    // Gil works nowhere else: every session ended, and the organisation refuses them anyway.
    const me = await h.request("/v1/me", { token: gil.token, tenant: DEMO.tenantId });
    expect(me.status).toBe(401);
    expect(
      (await auth().query("SELECT 1 FROM auth.session WHERE user_id = $1", [gil.authUserId]))
        .rowCount,
    ).toBe(0);
    expect(await audits("platform.member.suspended", gil.id)).toEqual([
      {
        outcome: "success",
        reason: "staff_left",
        scope: { reasonCode: "staff_left", from: "active", entriesWaiting: 0, endsSessions: true },
      },
    ]);
    // A retry changes nothing and is not audited again as a change.
    expect(await (await suspend("manager", gil.id)).json()).toMatchObject({ replay: true });
    expect(await audits("platform.member.suspended", gil.id)).toHaveLength(1);

    const ended = await end("manager", gil.id);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ state: "left", replay: false });
    expect(await (await end("manager", gil.id)).json()).toMatchObject({ replay: true });
    const resuspend = await suspend("manager", gil.id);
    expect(resuspend.status).toBe(409);
    expect(await codeOf(resuspend)).toBe("membership_ended");

    const erased = await erase("manager", gil.id);
    expect(erased.status).toBe(200);
    expect(await erased.json()).toEqual({
      tenantUserId: gil.id,
      erased: true,
      deletionRequestClosed: true,
    });
    const factors = await auth().query(
      "SELECT 1 FROM auth.verification WHERE value = $1 OR identifier LIKE '%' || $1 || '%'",
      [gil.authUserId],
    );
    expect(factors.rowCount).toBe(0);
    for (const table of ["user", "session", "account", "passkey", "two_factor"]) {
      const column = table === "user" ? "id" : "user_id";
      const left = await auth().query(`SELECT 1 FROM auth.${table} WHERE ${column} = $1`, [
        gil.authUserId,
      ]);
      expect(left.rowCount, table).toBe(0);
    }
    // The member row stays, unlinked, so the note still names who wrote it (Regulation 17).
    expect(await stateOf(gil.id)).toEqual({
      status: "left",
      auth_user_id: null,
      display_name: "Gil Example",
    });
    const [author] = await sql<{ display_name: string; job_title: string }>(
      `SELECT u.display_name, u.job_title FROM care_note n JOIN tenant_user u ON u.id = n.created_by
        WHERE n.id = $1`,
      [note?.id],
    );
    expect(author).toEqual({ display_name: "Gil Example", job_title: "Care worker" });
    const [task] = await sql<{ id: string; status: string; status_reason: string }>(
      `SELECT id, status, status_reason FROM task
        WHERE kind = 'platform.account_deletion_request' AND source_id = $1`,
      [gil.id],
    );
    expect(task).toMatchObject({ status: "done", status_reason: "sign_in_erased" });
    expect(await audits("platform.account_deletion.completed", task?.id ?? "")).toEqual([
      {
        outcome: "success",
        reason: null,
        scope: { tenantUserId: gil.id, outcome: "sign_in_erased" },
      },
    ]);
    // Audited by opaque id only: never the address or the name.
    const trail = JSON.stringify(await audits("platform.member.sign_in_erased", gil.id));
    expect(trail).not.toContain("example.invalid");
    expect(trail).not.toContain("Gil");
    // A retry erases nothing more.
    expect(await (await erase("manager", gil.id)).json()).toMatchObject({ erased: false });
  });

  it("hazard HZ-006 asks before suspending a member whose phone holds entries, then chases the hold", async () => {
    const hal = await newMember("Hal");
    const device = "0199d000-0000-4000-8000-0000000d0566";
    const report = await h.request("/v1/sync/device-report", {
      method: "POST",
      token: hal.token,
      tenant: DEMO.tenantId,
      headers: { [DEVICE_HEADER]: device },
      body: {
        unsent: 0,
        refused: 0,
        held: 3,
        blocked: 0,
        oldestAgeSeconds: null,
        reportedAt: new Date().toISOString(),
      },
    });
    expect(report.status).toBeLessThan(300);
    const unconfirmed = await suspend("manager", hal.id);
    expect(unconfirmed.status).toBe(409);
    expect(await codeOf(unconfirmed)).toBe("entries_waiting");
    expect((await stateOf(hal.id))?.status).toBe("active");
    expect(
      (await audits("platform.member.suspended", hal.id)).map((a) => [a.outcome, a.reason]),
    ).toEqual([["denied", "entries_waiting"]]);
    const done = await suspend("manager", hal.id, { confirmEntriesWaiting: true });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ state: "suspended", entriesWaiting: 3 });
    // Hal will not sign in to send them: the hold falls due now and the manager is told.
    const notices = await sql(
      `SELECT 1 FROM notification WHERE kind = 'sync.revoked_device_waiting'
        AND recipient_tenant_user_id = $1 AND source_id = $2`,
      [DEMO.users.manager.id, device],
    );
    expect(notices).toHaveLength(1);
  });

  it("keeps the sign-in of someone who works for another organisation, and never signs them out", async () => {
    const [agency] = await sql<{ id: string; auth_user_id: string }>(
      "SELECT id, auth_user_id FROM tenant_user WHERE email = 'agency@example.invalid'",
    );
    const suspended = await suspend("owner", agency?.id ?? "");
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ sessionsEnded: 0 });
    const sessions = await auth().query("SELECT 1 FROM auth.session WHERE user_id = $1", [
      agency?.auth_user_id,
    ]);
    expect(sessions.rowCount).toBeGreaterThan(0);
    // Still at work in the other organisation.
    const there = await h.request("/v1/me", { token: h.tokens.agency, tenant: OTHER.tenantId });
    expect(there.status).toBe(200);
    expect((await end("owner", agency?.id ?? "")).status).toBe(200);
    const kept = await erase("owner", agency?.id ?? "");
    expect(kept.status).toBe(409);
    expect(await codeOf(kept)).toBe("sign_in_in_use");
    expect((await stateOf(agency?.id ?? ""))?.auth_user_id).toBe(agency?.auth_user_id);
    expect(
      (await audits("platform.member.sign_in_erased", agency?.id ?? "")).map((a) => a.reason),
    ).toEqual(["sign_in_in_use"]);
  });

  it("keeps the sign-in of a Harbour operator", async () => {
    // The nurse's sign-in is also a Thapsus operator's (the harness).
    const nurse = DEMO.users.nurse.id;
    const suspended = await suspend("owner", nurse);
    expect(suspended.status).toBe(200);
    // Suspension here never signs an operator out of Harbour itself.
    expect(await suspended.json()).toMatchObject({ sessionsEnded: 0 });
    const sessions = await auth().query("SELECT 1 FROM auth.session WHERE user_id = $1", [
      h.authIds.nurse,
    ]);
    expect(sessions.rowCount).toBeGreaterThan(0);
    expect((await end("owner", nurse)).status).toBe(200);
    const kept = await erase("owner", nurse);
    expect(kept.status).toBe(409);
    expect(await codeOf(kept)).toBe("sign_in_in_use");
    expect((await stateOf(nurse))?.auth_user_id).toBe(h.authIds.nurse);
  });
});

import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryThrottle, throttleAddress } from "../src/http/throttle";
import { createAdapter, MockEmail, MockPush, MockSms } from "../src/integrations/adapters";
import { createLogger } from "../src/logger";
import {
  definerRefusal,
  INVITATION_EMAIL_TITLE,
  invitationTokenHash,
  newInvitationToken,
  sweepInvitations,
} from "../src/services/invitations";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Invitation routes (PLAT-004; platform.md, Invitations and MFA enrolment; hazard HZ-011): send,
 * list and revoke only within the reach of platform.user.manage (#48 review); open and accept a
 * link with no session; the first owner's invitation by an operator; the nightly sweep. The token
 * is only ever in the email's link and request bodies: never in an audit row or a response.
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

async function asOwnerTenant(tenantId: string, sql: string, params: unknown[] = []) {
  const client = await owner().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId],
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

/** A new invited member with one role (at a location, or across the organisation when null). */
async function invitedMember(roleKey: string, locationId: string | null) {
  n += 1;
  const email = `invitee${n}@example.invalid`;
  const [row] = await asOwnerTenant(
    DEMO.tenantId,
    `INSERT INTO tenant_user (display_name, email, status) VALUES ($1, $2, 'invited') RETURNING id`,
    [`Ada Example ${n}`, email],
  );
  const id = (row as { id: string }).id;
  await asOwnerTenant(
    DEMO.tenantId,
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $3 FROM role WHERE key = $2`,
    [id, roleKey, locationId],
  );
  return { id, email };
}

const post = (path: string, body: unknown, token?: string) =>
  h.request(path, {
    method: "POST",
    body,
    ...(token ? { token, tenant: DEMO.tenantId } : {}),
  });

/** Invites as a member and returns the response with the token from the emailed link. */
async function invite(memberId: string, as = "owner") {
  const before = h.handle.services.mockEmail.sent.length;
  const response = await post("/v1/invitations", { tenantUserId: memberId }, h.tokens[as]);
  const mail = h.handle.services.mockEmail.sent.slice(before).at(-1);
  const token = mail?.link?.split("#")[1] ?? "";
  return { response, token, mail };
}

const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

describe("table-driven: what the definer functions raise", () => {
  it.each([
    ["invitation_used", "invitation_used"],
    ["email_mismatch", "email_mismatch"],
    ["already_member", "already_member"],
    ["invitation_not_found", "not_found"],
    ["duplicate key value violates unique constraint", null],
    [undefined, null],
  ])("maps %s to %s", (message, expected) => {
    expect(definerRefusal({ message })).toBe(expected);
  });

  it("hashes a token as the database does, and makes 43-character base64url tokens", async () => {
    const { token, hash } = newInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const db = await owner().query("SELECT app.invitation_token_hash($1) AS h", [token]);
    expect(db.rows[0].h).toBe(hash);
    expect(invitationTokenHash(token)).toBe(hash);
  });

  it("never hands anything to the mock email in production, even when a connection names it", async () => {
    const email = new MockEmail();
    const mocks = { email, sms: new MockSms(), push: new MockPush() };
    const message = {
      idempotencyKey: "k",
      title: INVITATION_EMAIL_TITLE,
      link: null,
      to: "a@example.invalid",
    };
    const live = createAdapter(
      "comms.email",
      { provider: "mock", settings: {} },
      { production: true, mocks },
    );
    expect((await live.send(message)).ok).toBe(false);
    expect(email.sent).toHaveLength(0);
    const dev = createAdapter(
      "comms.email",
      { provider: "mock", settings: {} },
      { production: false, mocks },
    );
    expect((await dev.send(message)).ok).toBe(true);
  });

  it.each([
    ["one client hop", "203.0.113.7", [], "203.0.113.7"],
    ["a forged left entry", "198.51.100.1, 203.0.113.7", [], "203.0.113.7"],
    [
      "the trusted proxy skipped",
      "198.51.100.1, 203.0.113.7, 10.0.0.5",
      ["10.0.0.0/8"],
      "203.0.113.7",
    ],
    ["only trusted hops", "10.0.0.5", ["10.0.0.0/8"], null],
    ["no header", undefined, [], null],
    ["garbage on the right", "203.0.113.7, nonsense", [], null],
  ] as const)("throttles by the right-most untrusted hop: %s", (_, header, trusted, expected) => {
    expect(throttleAddress(header, trusted)).toBe(expected);
  });

  it("throttles per key in a sliding window", () => {
    const t = new MemoryThrottle(2, 60_000);
    expect(t.take("a", 0)).toBeNull();
    expect(t.take("a", 1)).toBeNull();
    expect(t.take("a", 2)).toBe(60);
    expect(t.take("b", 2)).toBeNull();
    expect(t.take("a", 60_001)).toBeNull();
  });
});

describe("hazard HZ-011 sending, listing and revoking within reach (#48 review)", () => {
  it("emails a generic link with the token only in its fragment, and audits without it", async () => {
    const m = await invitedMember("care_worker", DEMO.locationId);
    const { response, token, mail } = await invite(m.id);
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.emailSent).toBe(true);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(mail).toMatchObject({ title: INVITATION_EMAIL_TITLE, to: m.email });
    expect(mail?.link).toBe(`http://localhost:3000/invitation#${token}`);
    const audits = await asOwnerTenant(
      DEMO.tenantId,
      "SELECT action, scope::text, reason FROM audit_event WHERE resource_id = $1",
      [body.id],
    );
    expect(audits.map((a) => (a as { action: string }).action)).toContain(
      "platform.invitation.sent",
    );
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain(m.email);
  });

  // A location role reaches only members wholly at its homes; the owner reaches everyone.
  it.each([
    ["owner", LODGE.locationId, "reached"],
    ["manager", DEMO.locationId, "reached"],
    ["manager", LODGE.locationId, "not reached"],
    ["manager", null, "not reached"],
  ] as const)("%s and a member at %s: %s", async (as, location, expected) => {
    const m = await invitedMember("care_worker", location);
    const sent = await invite(m.id, as);
    const list = await h.request(`/v1/invitations?tenantUserId=${m.id}`, {
      token: h.tokens[as],
      tenant: DEMO.tenantId,
    });
    if (expected === "not reached") {
      expect(sent.response.status).toBe(404);
      expect(list.status).toBe(404);
      // An invitation the owner sent is still out of the manager's reach to withdraw.
      const byOwner = await invite(m.id, "owner");
      const id = ((await byOwner.response.json()) as { id: string }).id;
      expect((await post(`/v1/invitations/${id}/revoke`, {}, h.tokens.manager)).status).toBe(404);
      return;
    }
    expect(sent.response.status).toBe(201);
    const { items } = (await list.json()) as { items: { id: string; state: string }[] };
    expect(items).toHaveLength(1);
    expect(items[0]?.state).toBe("pending");
    expect(JSON.stringify(items)).not.toContain(m.email);
    const revoke = await post(`/v1/invitations/${items[0]?.id}/revoke`, {}, h.tokens[as]);
    expect(revoke.status).toBe(204);
    const again = await post(`/v1/invitations/${items[0]?.id}/revoke`, {}, h.tokens[as]);
    expect(await codeOf(again)).toBe("invitation_closed");
    const lookup = await post("/v1/invitations/lookup", { token: sent.token });
    expect(((await lookup.json()) as { refusal: string }).refusal).toBe("invitation_revoked");
  });

  it("refuses a member whose roles hold permissions the sender does not hold there", async () => {
    await asOwnerTenant(
      DEMO.tenantId,
      `INSERT INTO role (key, name, scope_kind, permissions, is_builtin)
       VALUES ('role_designer', 'Role designer', 'location', '{platform.role.manage}', false)`,
    );
    const m = await invitedMember("role_designer", DEMO.locationId);
    const { response } = await invite(m.id, "manager");
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("beyond_inviter");
  });

  it("refuses a member who is not still invited, and supersedes an open invitation", async () => {
    const m = await invitedMember("care_worker", DEMO.locationId);
    const first = await invite(m.id);
    const second = await invite(m.id);
    expect(second.response.status).toBe(201);
    const old = await post("/v1/invitations/lookup", { token: first.token });
    expect(((await old.json()) as { refusal: string }).refusal).toBe("invitation_revoked");
    const active = await invite(DEMO.users.carer.id);
    expect(await codeOf(active.response)).toBe("member_active");
  });
});

describe("hazard HZ-011 opening and accepting a link with no session", () => {
  it("looks up, refuses a weak password, creates a sign-in and links the member once", async () => {
    const m = await invitedMember("care_worker", DEMO.locationId);
    const { token } = await invite(m.id);
    const lookup = await post("/v1/invitations/lookup", { token });
    expect(await lookup.json()).toMatchObject({
      organisationName: expect.any(String),
      emailMasked: `i***@example.invalid`,
      refusal: null,
      path: "create_sign_in",
    });
    const weak = await post("/v1/invitations/accept", {
      token,
      password: "password1234",
      name: "Ada",
    });
    expect(weak.status).toBe(422);
    const accepted = await post("/v1/invitations/accept", {
      token,
      password: "four random harbour words",
      name: "Ada Example",
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ tenantId: DEMO.tenantId, next: "sign_in" });
    const [linked] = await asOwnerTenant(
      DEMO.tenantId,
      "SELECT status, auth_user_id FROM tenant_user WHERE id = $1",
      [m.id],
    );
    expect(linked).toMatchObject({ status: "active", auth_user_id: expect.any(String) });
    const again = await post("/v1/invitations/accept", { token, password: "x", name: "x" });
    expect(await codeOf(again)).toBe("invitation_used");
    const audited = await asOwnerTenant(
      DEMO.tenantId,
      "SELECT action FROM audit_event WHERE action LIKE 'platform.invitation.%' AND resource_type = 'invitation'",
    );
    expect(audited.map((a) => (a as { action: string }).action)).toEqual(
      expect.arrayContaining(["platform.invitation.claimed", "platform.invitation.accepted"]),
    );
  });

  it("never sets an existing sign-in's password: sign in first, then accept signed in", async () => {
    // The agency worker already has a sign-in; a second member record at the demo home.
    const [row] = await asOwnerTenant(
      DEMO.tenantId,
      `INSERT INTO tenant_user (display_name, email, status) VALUES ('Agency Ash', 'rae@example.invalid', 'invited') RETURNING id`,
    );
    const id = (row as { id: string }).id;
    await asOwnerTenant(
      DEMO.tenantId,
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'care_worker'`,
      [id, DEMO.locationId],
    );
    const { token } = await invite(id);
    const lookup = await post("/v1/invitations/lookup", { token });
    expect(((await lookup.json()) as { path: string }).path).toBe("sign_in_first");
    const blind = await post("/v1/invitations/accept", {
      token,
      password: "four random harbour words",
      name: "x",
    });
    expect(await codeOf(blind)).toBe("sign_in_first");
    const wrong = await h.request("/v1/invitations/accept", {
      method: "POST",
      body: { token },
      token: h.tokens.carer,
    });
    expect(await codeOf(wrong)).toBe("email_mismatch");
    const signedIn = await h.request("/v1/invitations/accept", {
      method: "POST",
      body: { token },
      token: h.tokens.rae,
    });
    expect(signedIn.status).toBe(200);
    expect(((await signedIn.json()) as { next: string }).next).toBe("enrol");
  });

  it("answers an unknown token with 404 and a platform audit event", async () => {
    const { token } = newInvitationToken();
    const response = await post("/v1/invitations/lookup", { token });
    expect(response.status).toBe(404);
    // Platform events (no organisation) are read by the operator role.
    const rows = await h.db
      .pool("harbour_operator")
      .query(
        "SELECT count(*)::int AS n FROM audit_event WHERE tenant_id IS NULL AND action = 'platform.invitation.lookup' AND reason = 'unknown_token'",
      );
    expect(rows.rows[0].n).toBeGreaterThan(0);
    expect((await post("/v1/invitations/lookup", { token: "short" })).status).toBe(422);
  });
});

describe("hazard HZ-011 the first owner's invitation by an operator", () => {
  it("invites only an organisation's invited owner, admins only, superseding the last", async () => {
    const provisioned = await h.request("/operator/tenants", {
      method: "POST",
      token: h.tokens.opsAdmin,
      body: {
        name: "Example Care",
        legalName: "Example Care Ltd",
        legalForm: "limited_company",
        owner: { displayName: "Ada Example", email: "ada.owner@example.invalid" },
      },
    });
    expect(provisioned.status).toBe(201);
    const { id } = (await provisioned.json()) as { id: string };
    const path = `/operator/tenants/${id}/owner-invitation`;
    const support = await h.request(path, { method: "POST", token: h.tokens.opsSupport });
    expect(support.status).toBe(403);
    const first = await h.request(path, { method: "POST", token: h.tokens.opsAdmin });
    expect(first.status).toBe(201);
    expect(h.handle.services.mockEmail.sent.at(-1)?.to).toBe("ada.owner@example.invalid");
    const second = await h.request(path, { method: "POST", token: h.tokens.opsAdmin });
    expect(second.status).toBe(201);
    const busy = await h.request(`/operator/tenants/${DEMO.tenantId}/owner-invitation`, {
      method: "POST",
      token: h.tokens.opsAdmin,
    });
    expect(await codeOf(busy)).toBe("organisation_has_members");
  });
});

describe("hazard HZ-011 the nightly sweep", () => {
  it("revokes lapsed invitations and deletes only sign-ins left unlinked", async () => {
    const lapsed = await invitedMember("care_worker", DEMO.locationId);
    const lapsedToken = newInvitationToken();
    const client = await owner().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
                set_config('app.user_id', $2, true)`,
        [DEMO.tenantId, DEMO.users.owner.id],
      );
      await client.query(
        `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, clock_timestamp() + interval '1 second', $3)`,
        [lapsed.id, lapsedToken.hash, DEMO.users.owner.id],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    // An acceptance that created a sign-in and stopped before linking it.
    const stopped = await invitedMember("care_worker", DEMO.locationId);
    const { token } = await invite(stopped.id);
    const signUp = await post("/api/auth/sign-up/email", {
      email: stopped.email,
      password: "four random harbour words",
      name: "Ada Example",
    });
    const authId = ((await signUp.json()) as { user: { id: string } }).user.id;
    const recorded = await h.db
      .pool("harbour_app")
      .query("SELECT app.record_invitation_sign_in($1, $2) AS ok", [token, authId]);
    expect(recorded.rows[0].ok).toBe(true);
    // Sign-ins left unlinked for any time at all (the rate table says 24 hours).
    const unlinkedHours = (value: number) =>
      owner().query(
        "UPDATE rate_table SET value = $1 WHERE key = 'invitation.unlinked_sign_in_hours' AND tenant_id IS NULL",
        [value],
      );
    await unlinkedHours(0);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    try {
      const counts = await sweepInvitations({
        workerPool: h.db.pool("harbour_worker"),
        appPool: h.db.pool("harbour_app"),
        authPool: h.db.pool("harbour_auth"),
        logger: createLogger("silent"),
      });
      expect(counts.expired).toBeGreaterThanOrEqual(1);
      expect(counts.signInsRemoved).toBe(1);
    } finally {
      await unlinkedHours(24);
    }
    const gone = await h.db
      .pool("harbour_auth")
      .query('SELECT 1 FROM auth."user" WHERE id = $1', [authId]);
    expect(gone.rowCount).toBe(0);
    const lookup = await post("/v1/invitations/lookup", { token: lapsedToken.token });
    expect(((await lookup.json()) as { refusal: string }).refusal).toBe("invitation_revoked");
  });
});

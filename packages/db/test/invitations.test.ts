import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Invitations in the database (PLAT-004; platform.md, Invitations and MFA enrolment; migration
 * 0054; hazard HZ-011; #43 review rounds 1 and 2): cross-tenant denial; sending only in the
 * session's member's own name, by a holder of platform.user.manage who holds every permission of
 * the member's roles; the address copied from the member; the operator's first-owner invitation
 * only through its definer function; lookup, claim and acceptance through definer functions that
 * take the raw token; single use; revocation in the reviser's name, or with none only on the
 * definer paths (the sweep, a member change by a job with no member); the address cleared when an
 * invitation closes; and the unlinked sign-in sweep touching only sign-ins invitations made.
 */

let db: TestDatabase;
const a = ids.a;
const TENANT_C = "0199f000-0000-7000-8000-00000000000c";
const app = () => db.pool("harbour_app");
const as =
  (userId: string | null, scope: "tenant" | "locations" | "assigned", locations: string[] = []) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(TENANT_A, userId, scope, locations), fn);
const asOwnerRole = as(a.manager, "tenant");
const asNorthManager = as(a.northManager, "locations", [a.locationNorth]);
const asCarer = as(a.carer, "assigned");
/** A worker job: no member, the organisation's view. */
const asJob = as(null, "tenant");
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);
/** Before anyone is signed in: no organisation chosen. */
const asAnonymous = <T>(fn: (c: pg.PoolClient) => Promise<T>) => inContext(app(), null, fn);
const asOwnerDb = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);

const INVITED_NORTH = "0199f000-0000-7000-8000-000000000301";
const INVITED_SOUTH = "0199f000-0000-7000-8000-000000000302";
const INVITED_AUDITOR = "0199f000-0000-7000-8000-000000000303";
const INVITED_C_OWNER = "0199f000-0000-7000-8000-000000000304";
const ROLE_MANAGER = "0199f000-0000-7000-8000-000000000501";
const ROLE_OWNER = "0199f000-0000-7000-8000-000000000502";
const ROLE_AUDITOR = "0199f000-0000-7000-8000-000000000503";
const ROLE_C_OWNER = "0199f000-0000-7000-8000-000000000504";
let adminOperator = "";
let supportOperator = "";
let tokens = 0;

const newToken = () => `test-token-${++tokens}`;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Sends an invitation as the session's member; the address is copied by the database. */
const invite = (
  c: pg.PoolClient,
  member: string,
  options: { token?: string; hours?: number; createdBy?: string | null } = {},
) =>
  c.query<{ id: string }>(
    `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4) RETURNING id`,
    [
      member,
      hashOf(options.token ?? newToken()),
      options.hours ?? 72,
      options.createdBy === undefined ? null : options.createdBy,
    ],
  );
/** Sends an invitation in the session's member's own name. */
const inviteAsSelf = (c: pg.PoolClient, member: string, token = newToken()) =>
  c.query(
    `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by)
     VALUES ($1, $2, now() + interval '72 hours', app.current_user_id())`,
    [member, hashOf(token)],
  );

const revokeOpen = (c: pg.PoolClient, member: string) =>
  c.query(
    `UPDATE invitation SET revoked_at = now(), revoked_by = app.current_user_id(),
       revocation_reason = 'superseded'
     WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [member],
  );

const openOf = (member: string) =>
  asOwnerDb(TENANT_A, (c) =>
    c
      .query<{
        id: string;
        email: string | null;
        revoked_by: string | null;
        revocation_reason: string | null;
      }>(
        `SELECT id, email, revoked_by, revocation_reason FROM invitation WHERE tenant_user_id = $1
         ORDER BY id DESC LIMIT 1`,
        [member],
      )
      .then((r) => r.rows[0]),
  );

const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow();

/** Ages a member's latest invitation past its expiry, as if three days had gone by. */
const lapse = (tenant: string, member: string) =>
  asOwnerDb(tenant, async (c) => {
    await c.query("ALTER TABLE invitation DISABLE TRIGGER invitation_guard");
    await c.query(
      `UPDATE invitation SET created_at = now() - interval '4 days',
         expires_at = now() - interval '1 day' WHERE tenant_user_id = $1 AND accepted_at IS NULL
         AND revoked_at IS NULL`,
      [member],
    );
    await c.query("ALTER TABLE invitation ENABLE TRIGGER invitation_guard");
  });

const addAuthUser = (id: string, email: string) =>
  db
    .pool("harbour_owner")
    .query("INSERT INTO auth.user (id, name, email) VALUES ($1, 'Invited Example', $2)", [
      id,
      email,
    ]);

beforeAll(async () => {
  db = await createTestDatabase();
  const owner = db.pool("harbour_owner");
  await seedTwoTenants(owner);
  await inContext(owner, null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status) VALUES
         ('invitation.expiry_hours', 72, 'hours', 'all', '2000-01-01', 'test', 'to-verify'),
         ('invitation.expiry_hours_max', 168, 'hours', 'all', '2000-01-01', 'test', 'to-verify'),
         ('invitation.unlinked_sign_in_hours', 24, 'hours', 'all', '2000-01-01', 'test', 'to-verify')`,
    ),
  );
  await asOwnerDb(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'registered_manager', 'Registered Manager', 'location', '{platform.user.manage,people.person.read}'),
         ($2, 'owner', 'Owner', 'tenant', '{platform.user.manage,people.person.read,platform.audit.read}'),
         ($3, 'auditor', 'Auditor', 'location', '{platform.audit.read}')`,
      [ROLE_MANAGER, ROLE_OWNER, ROLE_AUDITOR],
    );
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status) VALUES
         ($1, 'Ivy North', 'Ivy.North@example.invalid', 'invited'),
         ($2, 'Sol South', 'sol.south@example.invalid', 'invited'),
         ($3, 'Aud Itor', 'aud.itor@example.invalid', 'invited')`,
      [INVITED_NORTH, INVITED_SOUTH, INVITED_AUDITOR],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5), ($6, $7, $5), ($8, $7, $9), ($10, $11, $5)`,
      [
        a.manager,
        ROLE_OWNER,
        a.northManager,
        ROLE_MANAGER,
        a.locationNorth,
        INVITED_NORTH,
        a.roleCarer,
        INVITED_SOUTH,
        a.locationSouth,
        INVITED_AUDITOR,
        ROLE_AUDITOR,
      ],
    );
  });
  // A new organisation with only its invited owner, for the operator's first invitation.
  await asOwnerDb(TENANT_C, async (c) => {
    await c.query(
      `INSERT INTO tenant (id, name, legal_name, legal_form, status)
       VALUES ($1, 'New Provider', 'New Provider Ltd', 'limited_company', 'onboarding')`,
      [TENANT_C],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'owner', 'Owner', 'tenant', '{platform.user.manage}')`,
      [ROLE_C_OWNER],
    );
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Olive Owner', 'olive.owner@example.invalid', 'invited')`,
      [INVITED_C_OWNER],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      INVITED_C_OWNER,
      ROLE_C_OWNER,
    ]);
  });
  const { rows } = await owner.query<{ id: string; role: string }>(
    `INSERT INTO operator_user (auth_user_id, display_name, role) VALUES
       ('auth-op-admin', 'Ola Operator', 'admin'), ('auth-op-support', 'Sam Support', 'support')
     RETURNING id, role`,
  );
  adminOperator = rows.find((r) => r.role === "admin")?.id ?? "";
  supportOperator = rows.find((r) => r.role === "support")?.id ?? "";
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 sending an invitation (migration 0054)", () => {
  it("lets a holder of platform.user.manage invite a member it covers, in its own name", async () => {
    await asNorthManager((c) => inviteAsSelf(c, INVITED_NORTH));
    expect((await openOf(INVITED_NORTH))?.email).toBe("ivy.north@example.invalid");
    // A location role reaches no one at another home; a care worker invites no one.
    await refused(asNorthManager((c) => inviteAsSelf(c, INVITED_SOUTH)));
    await refused(asCarer((c) => inviteAsSelf(c, INVITED_SOUTH)));
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_SOUTH));
  });

  it("refuses an inviter who lacks a permission of the member's roles (#43 review M3)", async () => {
    // The auditor's role carries platform.audit.read, which the North manager does not hold.
    await refused(asNorthManager((c) => inviteAsSelf(c, INVITED_AUDITOR)));
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_AUDITOR));
  });

  it("is sent only in the session's member's name, never naming another (round 2, N2)", async () => {
    await asOwnerRole((c) => revokeOpen(c, INVITED_SOUTH));
    await refused(asOwnerRole((c) => invite(c, INVITED_SOUTH, { createdBy: a.northManager })));
    await refused(asOwnerRole((c) => invite(c, INVITED_SOUTH, { createdBy: null })));
    // The application role cannot write an operator or an address at all.
    await refused(
      asOwnerRole((c) =>
        c.query(
          `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by, created_by_operator)
           VALUES ($1, $2, now() + interval '1 day', app.current_user_id(), $3)`,
          [INVITED_SOUTH, hashOf(newToken()), adminOperator],
        ),
      ),
    );
    await refused(
      asOwnerRole((c) =>
        c.query(
          `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by, email)
           VALUES ($1, $2, now() + interval '1 day', app.current_user_id(), 'someone@example.invalid')`,
          [INVITED_SOUTH, hashOf(newToken())],
        ),
      ),
    );
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_SOUTH));
  });

  it("keeps one open invitation per member, and only for a member still invited", async () => {
    await refused(asOwnerRole((c) => inviteAsSelf(c, INVITED_SOUTH)));
    await refused(asOwnerRole((c) => inviteAsSelf(c, a.carer)));
    await refused(
      asOwnerRole((c) => invite(c, INVITED_SOUTH, { hours: -1, createdBy: a.manager })),
    );
    await refused(
      asOwnerRole((c) =>
        c.query(
          `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by)
           VALUES ($1, 'not-a-hash', now() + interval '1 day', app.current_user_id())`,
          [INVITED_SOUTH],
        ),
      ),
    );
  });

  it("never lets the application read a stored hash, or delete an invitation", async () => {
    await refused(asOwnerRole((c) => c.query("SELECT token_hash FROM invitation")));
    await refused(asOwnerRole((c) => c.query("DELETE FROM invitation")));
  });

  it("shows invitations to managers and to the member they are for, never across organisations", async () => {
    const seen = (fn: ReturnType<typeof as>) =>
      fn((c) =>
        c
          .query<{ tenant_user_id: string }>("SELECT DISTINCT tenant_user_id FROM invitation")
          .then((r) => r.rows.map((x) => x.tenant_user_id).sort()),
      );
    expect(await seen(asOwnerRole)).toEqual([INVITED_NORTH, INVITED_SOUTH, INVITED_AUDITOR].sort());
    expect(await seen(as(INVITED_NORTH, "assigned"))).toEqual([INVITED_NORTH]);
    expect(await seen(asCarer)).toEqual([]);
    expect((await asOtherTenant((c) => c.query("SELECT 1 FROM invitation"))).rowCount).toBe(0);
  });
});

describe("hazard HZ-011 the operator's first-owner invitation (#43 review M3, round 2)", () => {
  const firstOwner = (tenant: string, operator: string | null) =>
    inContext(db.pool("harbour_operator"), null, async (c) => {
      await c.query("SELECT set_config('app.operator_id', $1, true)", [operator ?? ""]);
      return c
        .query<{ email: string; expires_at: Date; tenant_user_id: string }>(
          "SELECT * FROM app.invite_first_owner($1, $2)",
          [tenant, hashOf(newToken())],
        )
        .then((r) => r.rows[0]);
    });

  it("invites only an organisation's invited owner while it has no active member", async () => {
    const sent = await firstOwner(TENANT_C, adminOperator);
    expect(sent?.tenant_user_id).toBe(INVITED_C_OWNER);
    expect(sent?.email).toBe("olive.owner@example.invalid");
    // The expiry is the rate table's, not the caller's.
    const hours = ((sent?.expires_at.getTime() ?? 0) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThanOrEqual(72);
    // Sent again: the first is superseded with no reviser.
    await firstOwner(TENANT_C, adminOperator);
    const rows = await asOwnerDb(TENANT_C, (c) =>
      c.query<{ revocation_reason: string | null; created_by_operator: string }>(
        "SELECT revocation_reason, created_by_operator FROM invitation WHERE tenant_id = $1 ORDER BY id",
        [TENANT_C],
      ),
    );
    expect(rows.rows.map((r) => r.revocation_reason)).toEqual(["superseded", null]);
    expect(rows.rows.every((r) => r.created_by_operator === adminOperator)).toBe(true);
    // The definer owner's open policies never reach harbour_owner's own queries (SET, not INHERIT).
    const seenByOwner = await asOwnerDb(TENANT_C, (c) => c.query("SELECT 1 FROM invitation"));
    expect(seenByOwner.rowCount).toBe(2);
    // Audited in the organisation's chain.
    const audit = await asOwnerDb(TENANT_C, (c) =>
      c.query(
        "SELECT 1 FROM audit_event WHERE action = 'platform.invitation.sent' AND tenant_id = $1",
        [TENANT_C],
      ),
    );
    expect(audit.rowCount).toBe(2);
  });

  it("refuses an organisation with active members, a support operator and no operator", async () => {
    await refused(firstOwner(TENANT_A, adminOperator));
    await refused(firstOwner(TENANT_C, supportOperator));
    await refused(firstOwner(TENANT_C, null));
    // Operators have no other way in.
    await refused(
      inContext(db.pool("harbour_operator"), ctx(TENANT_C, null, "tenant"), (c) =>
        c.query("SELECT 1 FROM invitation"),
      ),
    );
  });
});

describe("hazard HZ-011 opening and accepting a link (#43 review M2)", () => {
  const TOKEN = "accept-me-token";
  const IVY = "auth-ivy-north";

  it("looks a link up by its raw token, before anyone is signed in", async () => {
    await asNorthManager(async (c) => {
      await revokeOpen(c, INVITED_NORTH);
      await inviteAsSelf(c, INVITED_NORTH, TOKEN);
    });
    const found = await asAnonymous((c) =>
      c.query("SELECT * FROM app.invitation_for_token($1)", [TOKEN]),
    );
    expect(found.rows[0]).toMatchObject({
      tenant_id: TENANT_A,
      organisation_name: "Harbour Demo Care",
      email_masked: "i***@example.invalid",
      refusal: null,
    });
    // An unknown token, or the stored hash used as a token, finds nothing.
    expect(
      (await asAnonymous((c) => c.query("SELECT * FROM app.invitation_for_token('nope')")))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await asAnonymous((c) =>
          c.query("SELECT * FROM app.invitation_for_token($1)", [hashOf(TOKEN)]),
        )
      ).rowCount,
    ).toBe(0);
  });

  it("refuses a sign-in whose email is not the invitation's", async () => {
    await addAuthUser("auth-stranger", "stranger@example.invalid");
    await refused(
      asAnonymous((c) =>
        c.query("SELECT * FROM app.accept_invitation($1, 'auth-stranger')", [TOKEN]),
      ),
    );
  });

  it("claims, records the sign-in and accepts once, linking the member and clearing the address", async () => {
    await addAuthUser(IVY, "ivy.north@example.invalid");
    await asAnonymous(async (c) => {
      const claim = await c.query("SELECT * FROM app.claim_invitation($1)", [TOKEN]);
      expect(claim.rows[0]).toMatchObject({ tenant_user_id: INVITED_NORTH, refusal: null });
      expect(
        (await c.query("SELECT app.record_invitation_sign_in($1, $2) AS ok", [TOKEN, IVY])).rows[0]
          ?.ok,
      ).toBe(true);
      const accepted = await c.query("SELECT * FROM app.accept_invitation($1, $2)", [TOKEN, IVY]);
      expect(accepted.rows[0]).toMatchObject({
        tenant_id: TENANT_A,
        tenant_user_id: INVITED_NORTH,
      });
    });
    const member = await asOwnerDb(TENANT_A, (c) =>
      c.query("SELECT auth_user_id, status FROM tenant_user WHERE id = $1", [INVITED_NORTH]),
    );
    expect(member.rows[0]).toEqual({ auth_user_id: IVY, status: "active" });
    expect((await openOf(INVITED_NORTH))?.email).toBeNull();
    const audit = await asOwnerDb(TENANT_A, (c) =>
      c.query(
        "SELECT actor_tenant_user_id FROM audit_event WHERE action = 'platform.invitation.accepted'",
      ),
    );
    expect(audit.rows).toEqual([{ actor_tenant_user_id: INVITED_NORTH }]);
    // Single use.
    const again = await asAnonymous((c) =>
      c.query("SELECT refusal FROM app.claim_invitation($1)", [TOKEN]),
    );
    expect(again.rows[0]?.refusal).toBe("invitation_used");
    await refused(
      asAnonymous((c) => c.query("SELECT * FROM app.accept_invitation($1, $2)", [TOKEN, IVY])),
    );
  });

  it("never lets the application accept, or change an invitation but by revoking it", async () => {
    await refused(
      as(
        INVITED_SOUTH,
        "tenant",
      )((c) =>
        c.query(
          "UPDATE invitation SET accepted_at = now(), accepted_auth_user_id = 'x' WHERE tenant_user_id = $1",
          [INVITED_SOUTH],
        ),
      ),
    );
    await refused(
      asOwnerRole((c) =>
        c.query(
          "UPDATE invitation SET expires_at = expires_at + interval '1 day' WHERE tenant_user_id = $1",
          [INVITED_SOUTH],
        ),
      ),
    );
    // A revocation names the reviser: never another member, never no one from the application.
    for (const by of [a.northManager, null]) {
      await refused(
        asOwnerRole((c) =>
          c.query(
            `UPDATE invitation SET revoked_at = now(), revoked_by = $2, revocation_reason = 'revoked'
             WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
            [INVITED_SOUTH, by],
          ),
        ),
      );
    }
  });
});

describe("hazard HZ-011 revocations with no reviser (round 2, N1)", () => {
  it("lets a worker-style change to the member (no app.user_id) revoke an open invitation", async () => {
    expect((await openOf(INVITED_SOUTH))?.revocation_reason).toBeNull();
    await asJob((c) =>
      c.query("UPDATE tenant_user SET status = 'suspended' WHERE id = $1", [INVITED_SOUTH]),
    );
    expect(await openOf(INVITED_SOUTH)).toMatchObject({
      email: null,
      revoked_by: null,
      revocation_reason: "member_removed",
    });
  });

  it("records a manager changing the member's roles as the reviser", async () => {
    expect((await openOf(INVITED_AUDITOR))?.revocation_reason).toBeNull();
    await asOwnerRole((c) =>
      c.query(
        "UPDATE role_assignment SET valid_to = now() + interval '1 day' WHERE tenant_user_id = $1",
        [INVITED_AUDITOR],
      ),
    );
    expect(await openOf(INVITED_AUDITOR)).toMatchObject({
      email: null,
      revoked_by: a.manager,
      revocation_reason: "member_changed",
    });
  });

  it("sweeps a lapsed invitation with no member signed in, clearing its address", async () => {
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_AUDITOR));
    await lapse(TENANT_A, INVITED_AUDITOR);
    const swept = await inContext(db.pool("harbour_worker"), null, (c) =>
      c.query<{ n: number }>("SELECT app.sweep_expired_invitations() AS n"),
    );
    expect(swept.rows[0]?.n).toBe(1);
    expect(await openOf(INVITED_AUDITOR)).toMatchObject({
      email: null,
      revoked_by: null,
      revocation_reason: "expired",
    });
    // An open invitation not yet lapsed is never swept, and the member can be invited again.
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_AUDITOR));
    const none = await inContext(db.pool("harbour_worker"), null, (c) =>
      c.query<{ n: number }>("SELECT app.sweep_expired_invitations() AS n"),
    );
    expect(none.rows[0]?.n).toBe(0);
  });
});

describe("the unlinked sign-in sweep touches only sign-ins invitations made", () => {
  it("lists a claimed sign-in never linked, and never one the invitation path did not make", async () => {
    const token = newToken();
    await asOwnerDb(TENANT_A, (c) =>
      c.query(
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Una Linked', 'una@example.invalid', 'invited')",
        ["0199f000-0000-7000-8000-000000000305"],
      ),
    );
    await asOwnerRole((c) => inviteAsSelf(c, "0199f000-0000-7000-8000-000000000305", token));
    await addAuthUser("auth-una", "una@example.invalid");
    // A portal or professional sign-in with no membership, made some other way.
    await addAuthUser("auth-portal-user", "portal@example.invalid");
    await asAnonymous((c) =>
      c.query("SELECT app.record_invitation_sign_in($1, 'auth-una')", [token]),
    );
    const listed = () =>
      inContext(db.pool("harbour_worker"), null, (c) =>
        c
          .query<{ id: string }>("SELECT * FROM app.unlinked_invitation_sign_ins() AS id")
          .then((r) => r.rows.map((x) => x.id)),
      );
    // Not before invitation.unlinked_sign_in_hours.
    expect(await listed()).toEqual([]);
    await asOwnerDb(TENANT_A, async (c) => {
      await c.query("ALTER TABLE invitation DISABLE TRIGGER invitation_guard");
      await c.query(
        "UPDATE invitation SET claimed_at = now() - interval '25 hours' WHERE claimed_auth_user_id = 'auth-una'",
      );
      await c.query("ALTER TABLE invitation ENABLE TRIGGER invitation_guard");
    });
    const after = await listed();
    expect(after).toContain("auth-una");
    expect(after).not.toContain("auth-portal-user");
    // The accepted invitation's sign-in is linked, so never listed.
    expect(after).not.toContain("auth-ivy-north");
  });
});

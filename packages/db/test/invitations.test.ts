import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Invitations in the database (PLAT-004; platform.md, Invitations and MFA enrolment; migration
 * 0054; hazard HZ-011; #43 review rounds 1 and 2; #48 review round 1): cross-tenant denial;
 * sending only in the session's member's own name, by a holder of platform.user.manage who holds
 * every permission of the member's roles, with an expiry no later than the global ceiling; the
 * address copied from the member; the operator's first-owner invitation only through its definer
 * function; lookup, the recorded sign-in, claim and acceptance through definer functions that take
 * the raw token; single use; revocation in the reviser's name, or with none only on the definer
 * paths; audit events for every definer write; the address cleared when an invitation closes; and
 * the unlinked sign-in sweep touching only sign-ins invitations made and no one's membership.
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
/** Members added by single tests, each for one invitation story. */
const member = (n: number) => `0199f000-0000-7000-8000-000000000${String(300 + n)}`;
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

const revokeOpen = (c: pg.PoolClient, member: string, reason = "superseded") =>
  c.query(
    `UPDATE invitation SET revoked_at = now(), revoked_by = app.current_user_id(),
       revocation_reason = $2
     WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [member, reason],
  );

const openOf = (member: string) =>
  asOwnerDb(TENANT_A, (c) =>
    c
      .query<{
        id: string;
        email: string | null;
        revoked_by: string | null;
        revocation_reason: string | null;
        claimed_auth_user_id: string | null;
      }>(
        `SELECT id, email, revoked_by, revocation_reason, claimed_auth_user_id FROM invitation
         WHERE tenant_user_id = $1 ORDER BY id DESC LIMIT 1`,
        [member],
      )
      .then((r) => r.rows[0]),
  );

const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow();
/** Refused for the stated reason, so a test proves which rule refused it (#48 review M4). */
const refusedWith = (p: Promise<unknown>, reason: RegExp) => expect(p).rejects.toThrow(reason);

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

/** Writes a claim past the guard, a day old, as if recorded before #48 review H1's checks. */
const forceClaim = (member: string, authUserId: string) =>
  asOwnerDb(TENANT_A, async (c) => {
    await c.query("ALTER TABLE invitation DISABLE TRIGGER invitation_guard");
    await c.query(
      `UPDATE invitation SET claimed_auth_user_id = $2, claimed_at = now() - interval '25 hours'
       WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [member, authUserId],
    );
    await c.query("ALTER TABLE invitation ENABLE TRIGGER invitation_guard");
  });

/** Moves a recorded claim back past invitation.unlinked_sign_in_hours. */
const ageClaim = (authUserId: string) =>
  asOwnerDb(TENANT_A, async (c) => {
    await c.query("ALTER TABLE invitation DISABLE TRIGGER invitation_guard");
    await c.query(
      "UPDATE invitation SET claimed_at = now() - interval '25 hours' WHERE claimed_auth_user_id = $1",
      [authUserId],
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

const addInvitedMember = (id: string, email: string) =>
  asOwnerDb(TENANT_A, (c) =>
    c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Invited Example', $2, 'invited')`,
      [id, email],
    ),
  );

/** Step one of accepting, committed in its own transaction (#48 review M1). */
const recordSignIn = (token: string, authUserId: string) =>
  asAnonymous((c) =>
    c
      .query<{ ok: boolean }>("SELECT app.record_invitation_sign_in($1, $2) AS ok", [
        token,
        authUserId,
      ])
      .then((r) => r.rows[0]?.ok),
  );

const unlinked = () =>
  inContext(db.pool("harbour_worker"), null, (c) =>
    c
      .query<{ id: string }>("SELECT * FROM app.unlinked_invitation_sign_ins() AS id")
      .then((r) => r.rows.map((x) => x.id)),
  );

const auditOf = (tenant: string, invitationId: string | undefined, action: string) =>
  asOwnerDb(tenant, (c) =>
    c
      .query<{
        actor_tenant_user_id: string | null;
        actor_auth_user_id: string | null;
        actor_role_keys: string[];
        reason: string | null;
      }>(
        `SELECT actor_tenant_user_id, actor_auth_user_id, actor_role_keys, reason FROM audit_event
         WHERE tenant_id = $1 AND resource_type = 'invitation' AND resource_id = $2
           AND action = $3`,
        [tenant, invitationId, action],
      )
      .then((r) => r.rows),
  );

const settingsAfter = async (c: pg.PoolClient) =>
  (
    await c.query<{ tenant: string | null; user: string | null; scope: string | null }>(
      `SELECT current_setting('app.tenant_id', true) AS tenant,
              current_setting('app.user_id', true) AS user,
              current_setting('app.scope', true) AS scope`,
    )
  ).rows[0];

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

describe("hazard HZ-011 the invitation store's roles and grants (#48 review M4, lows)", () => {
  const FUNCTIONS = {
    forToken: "app.invitation_for_token(text)",
    record: "app.record_invitation_sign_in(text, text)",
    claim: "app.claim_invitation(text)",
    accept: "app.accept_invitation(text, text)",
    firstOwner: "app.invite_first_owner(uuid, text)",
    sweep: "app.sweep_expired_invitations()",
    unlinked: "app.unlinked_invitation_sign_ins()",
    audit: "app.invitation_audit(uuid, uuid, text, uuid, text, text[], text, jsonb)",
    membership: "app.auth_user_has_membership(text)",
    memberChanged: "app.invitation_member_changed()",
  } as const;
  type Fn = keyof typeof FUNCTIONS;
  const EXECUTE: [string, readonly Fn[]][] = [
    ["harbour_app", ["forToken", "record", "claim", "accept"]],
    ["harbour_operator", ["firstOwner"]],
    ["harbour_worker", ["sweep", "unlinked"]],
    ["harbour_sync", []],
    ["harbour_auth", []],
    // harbour_owner may SET ROLE to the definer owner but never inherits its rights (it does
    // inherit harbour_membership_reader's, from migration 0002).
    ["harbour_owner", ["membership"]],
  ];

  it.each(EXECUTE)("lets %s execute only its own invitation functions", async (role, allowed) => {
    const rows = await asOwnerDb(TENANT_A, (c) =>
      c.query<{ fn: Fn; ok: boolean }>(
        `SELECT f.key AS fn, has_function_privilege($1, f.value, 'EXECUTE') AS ok
         FROM jsonb_each_text($2::jsonb) AS f`,
        [role, JSON.stringify(FUNCTIONS)],
      ),
    );
    const granted = rows.rows
      .filter((r) => r.ok)
      .map((r) => r.fn)
      .sort();
    expect(granted).toEqual([...allowed].sort());
  });

  it("owns the definer functions by their NOLOGIN roles, set but never inherited", async () => {
    const owners = await asOwnerDb(TENANT_A, (c) =>
      c.query<{ proname: string; owner: string }>(
        `SELECT p.proname, r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.pronamespace = 'app'::regnamespace AND p.prosecdef
           AND (p.proname LIKE '%invitation%' OR p.proname IN ('invite_first_owner',
             'auth_user_has_membership'))`,
      ),
    );
    expect(Object.fromEntries(owners.rows.map((r) => [r.proname, r.owner]))).toEqual({
      invitation_for_token: "harbour_invitation_owner",
      record_invitation_sign_in: "harbour_invitation_owner",
      claim_invitation: "harbour_invitation_owner",
      accept_invitation: "harbour_invitation_owner",
      invite_first_owner: "harbour_invitation_owner",
      invitation_member_changed: "harbour_invitation_owner",
      sweep_expired_invitations: "harbour_invitation_owner",
      unlinked_invitation_sign_ins: "harbour_invitation_owner",
      auth_user_has_membership: "harbour_membership_reader",
    });
    const membership = await asOwnerDb(TENANT_A, (c) =>
      c.query(
        `SELECT m.inherit_option, m.set_option FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles g ON g.oid = m.member
         WHERE r.rolname = 'harbour_invitation_owner' AND g.rolname = 'harbour_owner'`,
      ),
    );
    expect(membership.rows).toEqual([{ inherit_option: false, set_option: true }]);
  });

  it("gives the definer owner only the columns it needs, and the application no hash or address writes", async () => {
    const checks: [string, string, string, string, boolean][] = [
      ["harbour_invitation_owner", "public.tenant_user", "email", "SELECT", true],
      ["harbour_invitation_owner", "public.tenant_user", "display_name", "SELECT", false],
      ["harbour_invitation_owner", "public.tenant_user", "email", "UPDATE", false],
      ["harbour_invitation_owner", "public.tenant", "legal_name", "SELECT", false],
      ["harbour_invitation_owner", 'auth."user"', "name", "SELECT", false],
      ["harbour_app", "public.invitation", "token_hash", "SELECT", false],
      ["harbour_app", "public.invitation", "email", "UPDATE", false],
      ["harbour_app", "public.invitation", "email", "INSERT", false],
      ["harbour_app", "public.invitation", "claimed_auth_user_id", "UPDATE", false],
    ];
    const rows = await asOwnerDb(TENANT_A, (c) =>
      c.query<{ ok: boolean }>(
        `SELECT has_column_privilege(x->>0, x->>1, x->>2, x->>3) AS ok
         FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS t(x, n) ORDER BY n`,
        [JSON.stringify(checks)],
      ),
    );
    expect(rows.rows.map((r) => r.ok)).toEqual(checks.map((x) => x[4]));
  });

  it.each(["harbour_sync", "harbour_worker", "harbour_operator"] as const)(
    "never lets %s read invitations",
    async (role) => {
      await refusedWith(
        inContext(db.pool(role), ctx(TENANT_A, null, "tenant"), (c) =>
          c.query("SELECT id FROM invitation"),
        ),
        /permission denied/,
      );
    },
  );
});

describe("hazard HZ-011 sending an invitation (migration 0054)", () => {
  it("lets a holder of platform.user.manage invite a member it covers, in its own name", async () => {
    await asNorthManager((c) => inviteAsSelf(c, INVITED_NORTH));
    expect((await openOf(INVITED_NORTH))?.email).toBe("ivy.north@example.invalid");
    // A location role reaches no one at another home; a care worker invites no one.
    await refusedWith(
      asNorthManager((c) => inviteAsSelf(c, INVITED_SOUTH)),
      /invitation_issue/,
    );
    await refusedWith(
      asCarer((c) => inviteAsSelf(c, INVITED_SOUTH)),
      /invitation_issue/,
    );
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_SOUTH));
  });

  it("refuses an inviter who lacks a permission of the member's roles (#43 review M3)", async () => {
    // The auditor's role carries platform.audit.read, which the North manager does not hold.
    await refusedWith(
      asNorthManager((c) => inviteAsSelf(c, INVITED_AUDITOR)),
      /invitation_issue/,
    );
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_AUDITOR));
  });

  it("is sent only in the session's member's name, never naming another (round 2, N2)", async () => {
    await asOwnerRole((c) => revokeOpen(c, INVITED_SOUTH));
    for (const createdBy of [a.northManager, null]) {
      await refusedWith(
        asOwnerRole((c) => invite(c, INVITED_SOUTH, { createdBy })),
        /sent in the name of the member sending it/,
      );
    }
    // The application role cannot write an operator or an address at all.
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by, created_by_operator)
           VALUES ($1, $2, now() + interval '1 day', app.current_user_id(), $3)`,
          [INVITED_SOUTH, hashOf(newToken()), adminOperator],
        ),
      ),
      /permission denied/,
    );
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by, email)
           VALUES ($1, $2, now() + interval '1 day', app.current_user_id(), 'someone@example.invalid')`,
          [INVITED_SOUTH, hashOf(newToken())],
        ),
      ),
      /permission denied/,
    );
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_SOUTH));
  });

  it("keeps one open invitation per member, and only for a member still invited", async () => {
    await refusedWith(
      asOwnerRole((c) => inviteAsSelf(c, INVITED_SOUTH)),
      /invitation_one_open_key/,
    );
    await refusedWith(
      asOwnerRole((c) => inviteAsSelf(c, a.carer)),
      /Only a member still invited, with no sign-in/,
    );
    await refusedWith(
      asOwnerRole((c) => invite(c, INVITED_SOUTH, { hours: -1, createdBy: a.manager })),
      /lapses in the future/,
    );
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          `INSERT INTO invitation (tenant_user_id, token_hash, expires_at, created_by)
           VALUES ($1, 'not-a-hash', now() + interval '1 day', app.current_user_id())`,
          [INVITED_SOUTH],
        ),
      ),
      /invitation_token_hash/,
    );
  });

  it("refuses a member with no second factor required, or one deleted (#48 review M4, low)", async () => {
    const noMfa = member(6);
    const deleted = member(7);
    await addInvitedMember(noMfa, "no.mfa@example.invalid");
    await addInvitedMember(deleted, "deleted@example.invalid");
    await asOwnerDb(TENANT_A, async (c) => {
      await c.query("UPDATE tenant_user SET mfa_required = false WHERE id = $1", [noMfa]);
      await c.query("UPDATE tenant_user SET deleted_at = now() WHERE id = $1", [deleted]);
    });
    for (const m of [noMfa, deleted]) {
      await refusedWith(
        asOwnerRole((c) => inviteAsSelf(c, m)),
        /Only a member still invited, with no sign-in and a second factor required/,
      );
    }
  });

  it("caps the expiry at the global invitation.expiry_hours_max, whatever the organisation's (#48 review M2)", async () => {
    const capped = member(8);
    await addInvitedMember(capped, "capped@example.invalid");
    // An organisation's own figure never raises the ceiling.
    await asOwnerDb(TENANT_A, (c) =>
      c.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
         VALUES ($1, 'invitation.expiry_hours_max', 1000, 'hours', 'all', '2000-01-01', 'test', 'to-verify')`,
        [TENANT_A],
      ),
    );
    await refusedWith(
      asOwnerRole((c) => invite(c, capped, { hours: 169, createdBy: a.manager })),
      /within invitation\.expiry_hours_max/,
    );
    await asOwnerRole((c) => invite(c, capped, { hours: 168, createdBy: a.manager }));
  });

  it("never lets the application read a stored hash, change an address or delete an invitation", async () => {
    await refusedWith(
      asOwnerRole((c) => c.query("SELECT token_hash FROM invitation")),
      /permission denied/,
    );
    await refusedWith(
      asOwnerRole((c) =>
        c.query("UPDATE invitation SET email = 'other@example.invalid' WHERE tenant_user_id = $1", [
          INVITED_SOUTH,
        ]),
      ),
      /permission denied/,
    );
    await refusedWith(
      asOwnerRole((c) => c.query("DELETE FROM invitation")),
      /permission denied/,
    );
  });

  it("shows invitations to managers and to the member they are for, never across organisations", async () => {
    const seen = (fn: ReturnType<typeof as>) =>
      fn((c) =>
        c
          .query<{ tenant_user_id: string }>("SELECT DISTINCT tenant_user_id FROM invitation")
          .then((r) => r.rows.map((x) => x.tenant_user_id).sort()),
      );
    expect(await seen(asOwnerRole)).toEqual(
      [INVITED_NORTH, INVITED_SOUTH, INVITED_AUDITOR, member(8)].sort(),
    );
    expect(await seen(as(INVITED_NORTH, "assigned"))).toEqual([INVITED_NORTH]);
    expect(await seen(asCarer)).toEqual([]);
    expect((await asOtherTenant((c) => c.query("SELECT 1 FROM invitation"))).rowCount).toBe(0);
  });

  it("refuses another organisation's insert or revocation (#48 review M4)", async () => {
    const before = await openOf(INVITED_SOUTH);
    // Naming this organisation outright, or its member under the other's own.
    await refused(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO invitation (tenant_id, tenant_user_id, token_hash, expires_at, created_by)
           VALUES ($1, $2, $3, now() + interval '1 day', app.current_user_id())`,
          [TENANT_A, INVITED_SOUTH, hashOf(newToken())],
        ),
      ),
    );
    await refused(asOtherTenant((c) => inviteAsSelf(c, INVITED_SOUTH)));
    const revoked = await asOtherTenant((c) =>
      c.query(
        `UPDATE invitation SET revoked_at = now(), revoked_by = app.current_user_id(),
           revocation_reason = 'revoked' WHERE tenant_user_id = $1`,
        [INVITED_SOUTH],
      ),
    );
    expect(revoked.rowCount).toBe(0);
    expect(await openOf(INVITED_SOUTH)).toEqual(before);
  });
});

describe("hazard HZ-011 the operator's first-owner invitation (#43 review M3, round 2)", () => {
  const firstOwner = (tenant: string, operator: string | null) =>
    inContext(db.pool("harbour_operator"), null, async (c) => {
      await c.query("SELECT set_config('app.operator_id', $1, true)", [operator ?? ""]);
      return c
        .query<{ invitation_id: string; email: string; expires_at: Date; tenant_user_id: string }>(
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
    // Sent again: the first is superseded with no reviser, and that is audited (#48 review M3).
    await firstOwner(TENANT_C, adminOperator);
    const rows = await asOwnerDb(TENANT_C, (c) =>
      c.query<{ revocation_reason: string | null; created_by_operator: string }>(
        "SELECT revocation_reason, created_by_operator FROM invitation WHERE tenant_id = $1 ORDER BY id",
        [TENANT_C],
      ),
    );
    expect(rows.rows.map((r) => r.revocation_reason)).toEqual(["superseded", null]);
    expect(rows.rows.every((r) => r.created_by_operator === adminOperator)).toBe(true);
    expect(await auditOf(TENANT_C, sent?.invitation_id, "platform.invitation.revoked")).toEqual([
      {
        actor_tenant_user_id: null,
        actor_auth_user_id: "auth-op-admin",
        actor_role_keys: ["thapsus_admin"],
        reason: "superseded",
      },
    ]);
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

  it("gives the caller back its own view of the database (#48 review, low)", async () => {
    const after = await inContext(db.pool("harbour_operator"), null, async (c) => {
      await c.query(
        `SELECT set_config('app.operator_id', $1, true), set_config('app.tenant_id', $2, true),
                set_config('app.scope', 'locations', true)`,
        [adminOperator, TENANT_B],
      );
      await c.query("SELECT * FROM app.invite_first_owner($1, $2)", [TENANT_C, hashOf(newToken())]);
      return settingsAfter(c);
    });
    expect(after).toEqual({ tenant: TENANT_B, user: "", scope: "locations" });
  });

  it("refuses an organisation with active members, a support operator and no operator", async () => {
    await refusedWith(firstOwner(TENANT_A, adminOperator), /organisation_has_members/);
    await refusedWith(firstOwner(TENANT_C, supportOperator), /operator_not_admin/);
    await refusedWith(firstOwner(TENANT_C, null), /operator_not_admin/);
    // Operators have no other way in.
    await refusedWith(
      inContext(db.pool("harbour_operator"), ctx(TENANT_C, null, "tenant"), (c) =>
        c.query("SELECT 1 FROM invitation"),
      ),
      /permission denied/,
    );
  });

  it("refuses an organisation not onboarding or active, and an owner role not live (#48 review, lows)", async () => {
    await asOwnerDb(TENANT_C, (c) =>
      c.query("UPDATE tenant SET status = 'suspended' WHERE id = $1", [TENANT_C]),
    );
    await refusedWith(firstOwner(TENANT_C, adminOperator), /organisation_not_active/);
    await asOwnerDb(TENANT_C, async (c) => {
      await c.query("UPDATE tenant SET status = 'onboarding' WHERE id = $1", [TENANT_C]);
      await c.query("UPDATE role SET archived_at = now() WHERE id = $1", [ROLE_C_OWNER]);
    });
    await refusedWith(firstOwner(TENANT_C, adminOperator), /no_invited_owner/);
    await asOwnerDb(TENANT_C, (c) =>
      c.query("UPDATE role SET archived_at = NULL WHERE id = $1", [ROLE_C_OWNER]),
    );
    expect((await firstOwner(TENANT_C, adminOperator))?.tenant_user_id).toBe(INVITED_C_OWNER);
  });
});

describe("hazard HZ-011 opening and accepting a link (#43 review M2; #48 review M1, M4)", () => {
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

  it("refuses a sign-in whose email is not the invitation's, and never records it", async () => {
    await addAuthUser("auth-stranger", "stranger@example.invalid");
    expect(await recordSignIn(TOKEN, "auth-stranger")).toBe(false);
    await refusedWith(
      asAnonymous((c) =>
        c.query("SELECT * FROM app.accept_invitation($1, 'auth-stranger')", [TOKEN]),
      ),
      /email_mismatch/,
    );
  });

  it("records the sign-in on its own, then claims and accepts once, linking the member", async () => {
    await addAuthUser(IVY, "ivy.north@example.invalid");
    // Step one, committed before the acceptance's transaction begins (#48 review M1); audited.
    expect(await recordSignIn(TOKEN, IVY)).toBe(true);
    const invitation = await openOf(INVITED_NORTH);
    expect(invitation?.claimed_auth_user_id).toBe(IVY);
    expect(await auditOf(TENANT_A, invitation?.id, "platform.invitation.claimed")).toEqual([
      { actor_tenant_user_id: null, actor_auth_user_id: IVY, actor_role_keys: [], reason: null },
    ]);
    // Claimed once: recording again, this sign-in or another, changes nothing.
    expect(await recordSignIn(TOKEN, IVY)).toBe(false);
    await asAnonymous(async (c) => {
      const claim = await c.query("SELECT * FROM app.claim_invitation($1)", [TOKEN]);
      expect(claim.rows[0]).toMatchObject({ tenant_user_id: INVITED_NORTH, refusal: null });
      const accepted = await c.query("SELECT * FROM app.accept_invitation($1, $2)", [TOKEN, IVY]);
      expect(accepted.rows[0]).toMatchObject({
        tenant_id: TENANT_A,
        tenant_user_id: INVITED_NORTH,
      });
      // The caller's view is given back (#48 review, low).
      expect(await settingsAfter(c)).toEqual({ tenant: "", user: "", scope: "" });
    });
    const linked = await asOwnerDb(TENANT_A, (c) =>
      c.query("SELECT auth_user_id, status FROM tenant_user WHERE id = $1 AND tenant_id = $2", [
        INVITED_NORTH,
        TENANT_A,
      ]),
    );
    expect(linked.rows[0]).toEqual({ auth_user_id: IVY, status: "active" });
    expect((await openOf(INVITED_NORTH))?.email).toBeNull();
    expect(await auditOf(TENANT_A, invitation?.id, "platform.invitation.accepted")).toEqual([
      {
        actor_tenant_user_id: INVITED_NORTH,
        actor_auth_user_id: IVY,
        actor_role_keys: [],
        reason: null,
      },
    ]);
    // Single use.
    const again = await asAnonymous((c) =>
      c.query("SELECT refusal FROM app.claim_invitation($1)", [TOKEN]),
    );
    expect(again.rows[0]?.refusal).toBe("invitation_used");
    await refusedWith(
      asAnonymous((c) => c.query("SELECT * FROM app.accept_invitation($1, $2)", [TOKEN, IVY])),
      /invitation_used/,
    );
  });

  it("keeps a recorded sign-in when the acceptance rolls back, for the sweep (#48 review M1)", async () => {
    const rolly = member(10);
    const token = newToken();
    await addInvitedMember(rolly, "rolly@example.invalid");
    await asOwnerRole((c) => inviteAsSelf(c, rolly, token));
    await addAuthUser("auth-rolly", "rolly@example.invalid");
    // The record, on one connection, commits.
    const first = await app().connect();
    try {
      const ok = await first.query<{ ok: boolean }>(
        "SELECT app.record_invitation_sign_in($1, 'auth-rolly') AS ok",
        [token],
      );
      expect(ok.rows[0]?.ok).toBe(true);
    } finally {
      first.release();
    }
    // The acceptance, on a second connection, fails after linking the member and rolls back.
    const second = await app().connect();
    try {
      await second.query("BEGIN");
      await second.query("SELECT * FROM app.claim_invitation($1)", [token]);
      await second.query("SELECT * FROM app.accept_invitation($1, 'auth-rolly')", [token]);
      await second.query("ROLLBACK");
    } finally {
      second.release();
    }
    expect(await openOf(rolly)).toMatchObject({
      email: "rolly@example.invalid",
      revocation_reason: null,
      claimed_auth_user_id: "auth-rolly",
    });
    // So the sweep can find the stray sign-in once it is old enough.
    expect(await unlinked()).not.toContain("auth-rolly");
    await ageClaim("auth-rolly");
    expect(await unlinked()).toContain("auth-rolly");
    // Once the sweep has deleted it, a new sign-in at the address may be recorded and accepted.
    await db.pool("harbour_owner").query("DELETE FROM auth.user WHERE id = 'auth-rolly'");
    await addAuthUser("auth-rolly-again", "rolly@example.invalid");
    expect(await recordSignIn(token, "auth-rolly-again")).toBe(true);
    await asAnonymous((c) =>
      c.query("SELECT * FROM app.accept_invitation($1, 'auth-rolly-again')", [token]),
    );
    expect(await unlinked()).not.toContain("auth-rolly-again");
  });

  it("refuses a lapsed or revoked invitation at every step (#48 review M4)", async () => {
    const lapsed = member(11);
    const revoked = member(12);
    const lapsedToken = newToken();
    const revokedToken = newToken();
    await addInvitedMember(lapsed, "lapsed@example.invalid");
    await addInvitedMember(revoked, "revoked@example.invalid");
    await asOwnerRole(async (c) => {
      await inviteAsSelf(c, lapsed, lapsedToken);
      await inviteAsSelf(c, revoked, revokedToken);
      await revokeOpen(c, revoked, "revoked");
    });
    await lapse(TENANT_A, lapsed);
    await addAuthUser("auth-lapsed", "lapsed@example.invalid");
    await addAuthUser("auth-revoked", "revoked@example.invalid");
    for (const [token, auth, refusal] of [
      [lapsedToken, "auth-lapsed", "invitation_expired"],
      [revokedToken, "auth-revoked", "invitation_revoked"],
    ] as const) {
      expect(await recordSignIn(token, auth)).toBe(false);
      const claim = await asAnonymous((c) =>
        c.query("SELECT refusal FROM app.claim_invitation($1)", [token]),
      );
      expect(claim.rows[0]?.refusal).toBe(refusal);
      await refusedWith(
        asAnonymous((c) => c.query("SELECT * FROM app.accept_invitation($1, $2)", [token, auth])),
        new RegExp(refusal),
      );
    }
    // A closed invitation stays closed.
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          `UPDATE invitation SET revoked_at = now(), revoked_by = app.current_user_id(),
             revocation_reason = 'superseded' WHERE tenant_user_id = $1`,
          [revoked],
        ),
      ),
      /accepted or revoked invitation is final/,
    );
  });

  it("never lets the application accept or claim, or change an invitation but by revoking it", async () => {
    await refusedWith(
      as(
        INVITED_SOUTH,
        "tenant",
      )((c) =>
        c.query(
          "UPDATE invitation SET accepted_at = now(), accepted_auth_user_id = 'x' WHERE tenant_user_id = $1",
          [INVITED_SOUTH],
        ),
      ),
      /permission denied/,
    );
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          "UPDATE invitation SET expires_at = expires_at + interval '1 day' WHERE tenant_user_id = $1",
          [INVITED_SOUTH],
        ),
      ),
      /permission denied/,
    );
    // Even the table's owner claims nothing outside the definer function.
    await refusedWith(
      asOwnerDb(TENANT_A, (c) =>
        c.query(
          `UPDATE invitation SET claimed_auth_user_id = 'auth-stranger', claimed_at = now()
           WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [INVITED_SOUTH],
        ),
      ),
      /changes only by being claimed, accepted or revoked/,
    );
    // A revocation names the reviser: never another member, never no one from the application.
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          `UPDATE invitation SET revoked_at = now(), revoked_by = $2, revocation_reason = 'revoked'
           WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [INVITED_SOUTH, a.northManager],
        ),
      ),
      /revokes an invitation in their own name/,
    );
    await refusedWith(
      asOwnerRole((c) =>
        c.query(
          `UPDATE invitation SET revoked_at = now(), revoked_by = NULL, revocation_reason = 'revoked'
           WHERE tenant_user_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
          [INVITED_SOUTH],
        ),
      ),
      /revoked in the name of the member revoking it/,
    );
    // A member revokes as revoked or superseded only, never as the system would (#48 review, low).
    for (const reason of ["expired", "member_removed", "member_changed"]) {
      await refusedWith(
        asOwnerRole((c) => revokeOpen(c, INVITED_SOUTH, reason)),
        /as revoked or superseded/,
      );
    }
  });
});

describe("hazard HZ-011 revocations when the member changes, or with no reviser (round 2, N1)", () => {
  it("lets a worker-style change to the member (no app.user_id) revoke an open invitation", async () => {
    const before = await openOf(INVITED_SOUTH);
    expect(before?.revocation_reason).toBeNull();
    // A system change with no member, as the leavers sweep makes through app.end_leaver_access
    // (which runs as harbour_owner): the application role itself can no longer change a member's
    // status (migration 0129).
    await asOwnerDb(TENANT_A, (c) =>
      c.query("UPDATE tenant_user SET status = 'suspended' WHERE id = $1", [INVITED_SOUTH]),
    );
    expect(await openOf(INVITED_SOUTH)).toMatchObject({
      email: null,
      revoked_by: null,
      revocation_reason: "member_removed",
    });
    // Audited, by the system (#48 review M3).
    expect(await auditOf(TENANT_A, before?.id, "platform.invitation.revoked")).toEqual([
      {
        actor_tenant_user_id: null,
        actor_auth_user_id: "system",
        actor_role_keys: ["system"],
        reason: "member_removed",
      },
    ]);
  });

  it("records a manager changing the member's roles as the reviser", async () => {
    const before = await openOf(INVITED_AUDITOR);
    expect(before?.revocation_reason).toBeNull();
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
    expect(await auditOf(TENANT_A, before?.id, "platform.invitation.revoked")).toEqual([
      {
        actor_tenant_user_id: a.manager,
        actor_auth_user_id: "auth-a-manager",
        actor_role_keys: [],
        reason: "member_changed",
      },
    ]);
  });

  it("revokes on a change of address, MFA requirement, grants or deletion (#48 review M4, low)", async () => {
    const changing = member(13);
    await addInvitedMember(changing, "changing@example.invalid");
    const changes: [string, string, string][] = [
      [
        "address",
        "UPDATE tenant_user SET email = 'changed@example.invalid' WHERE id = $1",
        "member_changed",
      ],
      [
        "MFA requirement",
        "UPDATE tenant_user SET mfa_required = false WHERE id = $1",
        "member_changed",
      ],
      [
        "grant",
        `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_to, reason, granted_by)
         VALUES ($1, '{people.person.read}', '${a.locationNorth}', now() + interval '1 day', 'Cover', '${a.manager}')`,
        "member_changed",
      ],
      ["deletion", "UPDATE tenant_user SET deleted_at = now() WHERE id = $1", "member_removed"],
    ];
    for (const [what, change, reason] of changes) {
      await asOwnerRole((c) => inviteAsSelf(c, changing));
      const open = await openOf(changing);
      await asOwnerDb(TENANT_A, (c) => c.query(change, [changing]));
      expect(await openOf(changing), what).toMatchObject({
        id: open?.id,
        email: null,
        revocation_reason: reason,
      });
      expect(await auditOf(TENANT_A, open?.id, "platform.invitation.revoked"), what).toHaveLength(
        1,
      );
      if (what === "MFA requirement") {
        // Without a second factor required, no invitation is sent at all.
        await refusedWith(
          asOwnerRole((c) => inviteAsSelf(c, changing)),
          /a second factor required/,
        );
        await asOwnerDb(TENANT_A, (c) =>
          c.query("UPDATE tenant_user SET mfa_required = true WHERE id = $1", [changing]),
        );
      }
    }
  });

  it("sweeps a lapsed invitation with no member signed in, clearing its address", async () => {
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_AUDITOR));
    await lapse(TENANT_A, INVITED_AUDITOR);
    const lapsed = await openOf(INVITED_AUDITOR);
    const swept = await inContext(db.pool("harbour_worker"), null, (c) =>
      c.query<{ n: number }>("SELECT app.sweep_expired_invitations() AS n"),
    );
    // The auditor's, and the lapsed one the refusal test left open.
    expect(swept.rows[0]?.n).toBe(2);
    expect(await openOf(INVITED_AUDITOR)).toMatchObject({
      email: null,
      revoked_by: null,
      revocation_reason: "expired",
    });
    expect(await auditOf(TENANT_A, lapsed?.id, "platform.invitation.expired")).toEqual([
      {
        actor_tenant_user_id: null,
        actor_auth_user_id: "system",
        actor_role_keys: ["system"],
        reason: "expired",
      },
    ]);
    // An open invitation not yet lapsed is never swept, and the member can be invited again; the
    // caller's view is given back (#48 review, low).
    await asOwnerRole((c) => inviteAsSelf(c, INVITED_AUDITOR));
    const none = await inContext(db.pool("harbour_worker"), null, async (c) => {
      await c.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'locations', true)",
        [TENANT_B],
      );
      const n = await c.query<{ n: number }>("SELECT app.sweep_expired_invitations() AS n");
      return { n: n.rows[0]?.n, settings: await settingsAfter(c) };
    });
    expect(none).toEqual({ n: 0, settings: { tenant: TENANT_B, user: "", scope: "locations" } });
  });
});

describe("the unlinked sign-in sweep touches only sign-ins invitations made (#48 review H1)", () => {
  it("lists a claimed sign-in never linked, and never one the invitation path did not make", async () => {
    const token = newToken();
    const una = member(5);
    await addInvitedMember(una, "una@example.invalid");
    await asOwnerRole((c) => inviteAsSelf(c, una, token));
    await addAuthUser("auth-una", "una@example.invalid");
    // A portal or professional sign-in with no membership, made some other way.
    await addAuthUser("auth-portal-user", "portal@example.invalid");
    expect(await recordSignIn(token, "auth-una")).toBe(true);
    // Not before invitation.unlinked_sign_in_hours.
    expect(await unlinked()).not.toContain("auth-una");
    await ageClaim("auth-una");
    const after = await unlinked();
    expect(after).toContain("auth-una");
    expect(after).not.toContain("auth-portal-user");
    // The accepted invitation's sign-in is linked, so never listed.
    expect(after).not.toContain("auth-ivy-north");
  });

  it("never records, or lists, a sign-in that is anyone's membership or an operator's", async () => {
    // A member of another organisation, signed up before anyone copied their address here.
    await addAuthUser("auth-victim", "victim@example.invalid");
    await addAuthUser("auth-leaver", "leaver@example.invalid");
    await asOwnerDb(TENANT_B, (c) =>
      c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
           ($1, 'auth-victim', 'Vic Member', 'victim@example.invalid', 'active'),
           ($2, 'auth-leaver', 'Lee Leaver', 'leaver@example.invalid', 'left')`,
        [member(20), member(21)],
      ),
    );
    const copied = member(14);
    const token = newToken();
    await addInvitedMember(copied, "Victim@example.invalid");
    await asOwnerRole((c) => inviteAsSelf(c, copied, token));
    // The sign-in predates the invitation, so it is not one the invitation made.
    expect(await recordSignIn(token, "auth-victim")).toBe(false);
    expect((await openOf(copied))?.claimed_auth_user_id).toBeNull();
    // Even a claim written past these checks never lists a member (in any organisation and any
    // state) or an operator for deletion.
    const operatorCopy = member(15);
    const leaverCopy = member(16);
    await addInvitedMember(operatorCopy, "operator.copy@example.invalid");
    await addInvitedMember(leaverCopy, "leaver.copy@example.invalid");
    await asOwnerRole(async (c) => {
      await inviteAsSelf(c, operatorCopy);
      await inviteAsSelf(c, leaverCopy);
    });
    await forceClaim(copied, "auth-victim");
    await forceClaim(leaverCopy, "auth-leaver");
    await forceClaim(operatorCopy, "auth-op-admin");
    const listed = await unlinked();
    expect(listed).toContain("auth-una");
    for (const kept of ["auth-victim", "auth-leaver", "auth-op-admin"]) {
      expect(listed).not.toContain(kept);
    }
  });
});

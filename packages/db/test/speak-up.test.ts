import { createHash, randomBytes, randomUUID } from "node:crypto";
import { builtinRole } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The speak-up silo in the database (Phase 2 slice 24; SAFE-012; ADR-0089; migration 0086). Only
 * the Freedom to Speak Up lead, members named on a case and the reporter of a named or confidential
 * concern read it; a public request reads one anonymous concern by its unexpired reply token's
 * hash. No wider role reaches it: not the owner, not the Registered Manager, not the owner database
 * role, not another organisation. The silo guards keep the lead's permission out of mixed roles,
 * grants, self-appointment (also by editing a role) and user or role management. Invented people.
 */

let db: TestDatabase;
const a = ids.a;
const GUARDIAN = "0199f000-0000-7000-8000-0000000003c1";
const QUALITY_LEAD = "0199f000-0000-7000-8000-0000000003c2";
const SPARE = "0199f000-0000-7000-8000-0000000003c3";
const ROLE_GUARDIAN = "0199f000-0000-7000-8000-0000000005c1";
const ROLE_OWNER = "0199f000-0000-7000-8000-0000000005c2";
const ROLE_RM = "0199f000-0000-7000-8000-0000000005c3";
const ROLE_QUALITY = "0199f000-0000-7000-8000-0000000005c4";
const ROLE_PLAIN = "0199f000-0000-7000-8000-0000000005c5";
type Run = <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
const app = () => db.pool("harbour_app");
const as =
  (userId: string, scope: "tenant" | "locations" = "tenant", tenant = TENANT_A): Run =>
  (fn) =>
    inContext(
      app(),
      ctx(tenant, userId, scope, scope === "locations" ? [a.locationNorth] : []),
      fn,
    );
const asGuardian = as(GUARDIAN);
const asOwnerRole = as(a.manager);
const asManager = as(a.northManager, "locations");
const asReporter = as(a.carer);
const asQualityLead = as(QUALITY_LEAD);
const asPublic =
  (replyTokenHash: string | null): Run =>
  (fn) =>
    inContext(app(), { ...ctx(TENANT_A, null, "none"), speakUp: { replyTokenHash } }, fn);
const ownerDb: Run = (fn) => inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const newToken = () => randomBytes(32).toString("base64url");
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const count = async (run: Run, table: string) =>
  run(async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n));

/** Raises a named or confidential concern as the reporter, through app.raise_speak_up. */
async function raise(identity: "named" | "confidential"): Promise<string> {
  const id = randomUUID();
  await asReporter(async (c) => {
    await c.query("SELECT app.raise_speak_up($1, $2, 'conduct', $3)", [
      id,
      identity,
      "A colleague shouts at residents at night.",
    ]);
    await c.query(
      "INSERT INTO speak_up_message (concern_id, from_reporter, body) VALUES ($1, true, 'It happened twice this week.')",
      [id],
    );
  });
  return id;
}

async function raiseAnonymous(token: string, expiresIn = "180 days"): Promise<void> {
  await asPublic(null)((c) =>
    c.query(
      `INSERT INTO speak_up_concern (identity, category, summary, received_on, reply_token_hash,
         reply_token_expires_at, created_by, updated_by)
       VALUES ('anonymous', 'care_quality_or_safety', 'Night checks are skipped.', current_date,
         $1, now() + $2::interval, NULL, NULL)`,
      [hashOf(token), expiresIn],
    ),
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status) VALUES
         ($1, 'Gail Guardian', 'gail.guardian@example.invalid', 'active'),
         ($2, 'Quinn Quality', 'quinn.quality@example.invalid', 'active'),
         ($3, 'Sol Spare', 'sol.spare@example.invalid', 'active')`,
      [GUARDIAN, QUALITY_LEAD, SPARE],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'speak_up_guardian', 'Freedom to Speak Up lead', 'tenant', '{safety.speak_up.manage}'),
         ($2, 'test_owner', 'Owner', 'tenant', $5),
         ($3, 'test_rm', 'Registered Manager', 'location', $6),
         ($4, 'test_quality', 'Quality lead', 'tenant', $7),
         ($8, 'test_plain', 'Plain', 'tenant', '{people.person.read}')`,
      [
        ROLE_GUARDIAN,
        ROLE_OWNER,
        ROLE_RM,
        ROLE_QUALITY,
        builtinRole("owner")?.permissions,
        builtinRole("registered_manager")?.permissions,
        builtinRole("quality_lead")?.permissions,
        ROLE_PLAIN,
      ],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, NULL), ($5, $6, $7), ($8, $9, NULL), ($10, $11, NULL)`,
      [
        GUARDIAN,
        ROLE_GUARDIAN,
        a.manager,
        ROLE_OWNER,
        a.northManager,
        ROLE_RM,
        a.locationNorth,
        QUALITY_LEAD,
        ROLE_QUALITY,
        SPARE,
        ROLE_PLAIN,
      ],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 the speak-up silo (migration 0086, ADR-0089)", () => {
  it("shows a confidential concern to the lead and its reporter, and to no wider role", async () => {
    const id = await raise("confidential");
    expect(await count(asGuardian, "speak_up_concern")).toBeGreaterThanOrEqual(1);
    expect(await count(asGuardian, "speak_up_reporter")).toBeGreaterThanOrEqual(1);
    const mine = await asReporter((c) =>
      c.query("SELECT id FROM speak_up_concern WHERE id = $1", [id]),
    );
    expect(mine.rows).toHaveLength(1);
    for (const [who, run] of [
      ["owner", asOwnerRole],
      ["Registered Manager", asManager],
      ["quality lead", asQualityLead],
      ["owner database role", ownerDb],
    ] as const) {
      for (const table of [
        "speak_up_concern",
        "speak_up_reporter",
        "speak_up_message",
        "speak_up_case_member",
        "speak_up_intake",
      ]) {
        expect(await count(run, table), `${who} reads ${table}`).toBe(0);
      }
    }
    expect(await count(as(ids.b.manager, "tenant", TENANT_B), "speak_up_concern")).toBe(0);
  });

  it("lets nobody write a reporter directly, so nobody claims someone else's concern", async () => {
    const id = await raise("confidential");
    for (const run of [asManager, asReporter, ownerDb]) {
      await expect(
        run((c) =>
          c.query("INSERT INTO speak_up_reporter (concern_id, tenant_user_id) VALUES ($1, $2)", [
            id,
            a.northManager,
          ]),
        ),
      ).rejects.toThrow(/row-level security|permission denied/);
    }
  });

  it("raises a named concern only through app.raise_speak_up, never storing its creator", async () => {
    await expect(
      asReporter((c) =>
        c.query(
          `INSERT INTO speak_up_concern (identity, category, summary, received_on, created_by, updated_by)
           VALUES ('named', 'other', 'The rota is unsafe.', current_date, NULL, NULL)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const id = await raise("named");
    const stored = await asGuardian((c) =>
      c.query("SELECT created_by, updated_by FROM speak_up_concern WHERE id = $1", [id]),
    );
    expect(stored.rows[0]).toEqual({ created_by: null, updated_by: null });
    await expect(
      asPublic(null)((c) =>
        c.query("SELECT app.raise_speak_up($1, 'named', 'other', 'No member here.')", [
          randomUUID(),
        ]),
      ),
    ).rejects.toThrow(/Only a member/);
  });

  it("opens an anonymous concern only to its unexpired reply token, and the lead", async () => {
    const token = newToken();
    await raiseAnonymous(token);
    expect(await count(asPublic(hashOf(token)), "speak_up_concern")).toBe(1);
    expect(await count(asPublic(hashOf(newToken())), "speak_up_concern")).toBe(0);
    expect(await count(asPublic(null), "speak_up_concern")).toBe(0);
    await expect(
      asReporter((c) =>
        c.query(
          `INSERT INTO speak_up_concern (identity, category, summary, received_on, created_by, updated_by)
           VALUES ('anonymous', 'other', 'Something is wrong.', current_date, NULL, NULL)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await asPublic(hashOf(token))(async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM speak_up_concern");
      await c.query(
        "INSERT INTO speak_up_message (concern_id, from_reporter, body) VALUES ($1, true, 'Still happening.')",
        [rows[0]?.id],
      );
    });
    expect(await count(asPublic(hashOf(token)), "speak_up_message")).toBe(1);
    expect(await count(asOwnerRole, "speak_up_concern")).toBe(0);

    // An expired token opens nothing, and a token never comes without its expiry.
    const expired = newToken();
    await raiseAnonymous(expired, "-1 second");
    expect(await count(asPublic(hashOf(expired)), "speak_up_concern")).toBe(0);
    await expect(
      asPublic(null)((c) =>
        c.query(
          `INSERT INTO speak_up_concern (identity, category, summary, received_on, reply_token_hash)
           VALUES ('anonymous', 'other', 'No expiry.', current_date, $1)`,
          [hashOf(newToken())],
        ),
      ),
    ).rejects.toThrow(/speak_up_concern_token_expiry/);
  });

  it("shows a case to the members the lead names, and a named reporter only on a named case", async () => {
    const confidential = await raise("confidential");
    const named = await raise("named");
    await asGuardian(async (c) => {
      for (const id of [confidential, named]) {
        await c.query(
          "INSERT INTO speak_up_case_member (concern_id, tenant_user_id, added_by) VALUES ($1, $2, $3)",
          [id, a.northManager, GUARDIAN],
        );
      }
    });
    const seen = await asManager((c) => c.query("SELECT id FROM speak_up_concern ORDER BY id"));
    expect(seen.rows.map((r) => r.id).sort()).toEqual([confidential, named].sort());
    const reporters = await asManager((c) => c.query("SELECT concern_id FROM speak_up_reporter"));
    expect(reporters.rows.map((r) => r.concern_id)).toEqual([named]);
    await expect(
      asManager((c) =>
        c.query(
          "INSERT INTO speak_up_case_member (concern_id, tenant_user_id, added_by) VALUES ($1, $2, $2)",
          [named, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const changed = await asManager((c) =>
      c.query("UPDATE speak_up_concern SET state = 'acknowledged' WHERE id = $1", [named]),
    );
    expect(changed.rowCount).toBe(0);
  });

  it("never copies a concern into the shared version history", async () => {
    const id = await raise("confidential");
    await asGuardian((c) =>
      c.query(
        "UPDATE speak_up_concern SET state = 'acknowledged', acknowledged_at = now() WHERE id = $1",
        [id],
      ),
    );
    const history = await ownerDb((c) =>
      c.query("SELECT 1 FROM record_version WHERE table_name LIKE 'speak_up_%'"),
    );
    expect(history.rows).toEqual([]);
  });

  it("keeps messages and reporters as written, and nothing is deleted", async () => {
    const id = await raise("named");
    await expect(
      asGuardian((c) =>
        c.query("UPDATE speak_up_message SET body = 'x' WHERE concern_id = $1", [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asGuardian((c) => c.query("DELETE FROM speak_up_concern WHERE id = $1", [id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("shows speak-up audit events to the lead only, and the chain still verifies for everyone", async () => {
    const id = await raise("confidential");
    await asReporter((c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, scope)
         VALUES ($2, 'safety.speak_up.raise', 'speak_up_concern', $1, '{"actor":"reporter"}')`,
        [id, TENANT_A],
      ),
    );
    const read = (run: Run) =>
      run(async (c) => {
        const { rows } = await c.query("SELECT 1 FROM audit_event WHERE resource_id = $1", [id]);
        return rows.length;
      });
    expect(await read(asGuardian)).toBe(1);
    for (const run of [asOwnerRole, asManager, ownerDb]) expect(await read(run)).toBe(0);
    for (const run of [asOwnerRole, ownerDb, asGuardian]) {
      const { rows } = await run((c) => c.query("SELECT app.verify_audit_chain() AS broken"));
      expect(rows[0]?.broken).toBeNull();
    }
  });

  it("counts public intake only on a public request; the lead reads the daily count only", async () => {
    await asPublic(null)((c) =>
      c.query(
        `INSERT INTO speak_up_intake (bucket, window_start, window_end, hits) VALUES
           ('day', date_trunc('day', now()), date_trunc('day', now()) + interval '1 day', 3),
           ('tenant', date_trunc('minute', now()), date_trunc('minute', now()) + interval '1 minute', 1)`,
      ),
    );
    const lead = await asGuardian((c) => c.query("SELECT bucket FROM speak_up_intake"));
    expect(lead.rows.map((r) => r.bucket)).toEqual(["day"]);
    await expect(
      asReporter((c) =>
        c.query(
          "INSERT INTO speak_up_intake (bucket, window_start, window_end) VALUES ('tenant', now(), now() + interval '1 minute')",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-011 the silo guards (ADR-0089)", () => {
  it("refuses a role that mixes the silo permission with another", async () => {
    await expect(
      ownerDb((c) =>
        c.query(
          `INSERT INTO role (key, name, scope_kind, permissions)
           VALUES ('mixed', 'Mixed', 'tenant', '{safety.speak_up.manage,platform.audit.read}')`,
        ),
      ),
    ).rejects.toThrow(/carries nothing else/);
  });

  it("refuses an access grant carrying the silo permission", async () => {
    await expect(
      ownerDb((c) =>
        c.query(
          `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_from, valid_to,
             reason, granted_by)
           VALUES ($1, '{safety.speak_up.manage}', $2, now(), now() + interval '1 day',
             'Acting up', $3)`,
          [a.carer, a.locationNorth, a.manager],
        ),
      ),
    ).rejects.toThrow(/never given by an access grant/);
  });

  it("refuses self-appointment, and the silo held with user or role management", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          a.manager,
          ROLE_GUARDIAN,
        ]),
      ),
    ).rejects.toThrow(/appoints themselves|row-level security|permission denied/);
    await expect(
      ownerDb((c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          a.manager,
          ROLE_GUARDIAN,
        ]),
      ),
    ).rejects.toThrow(/never held with user or role management/);
    await expect(
      ownerDb((c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          GUARDIAN,
          ROLE_OWNER,
        ]),
      ),
    ).rejects.toThrow(/never held with user or role management/);
  });

  it("refuses a role edit that would get round the guards (security review M4)", async () => {
    // A role the lead already holds gains user management.
    await ownerDb((c) =>
      c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
        GUARDIAN,
        ROLE_PLAIN,
      ]),
    );
    await expect(
      ownerDb((c) =>
        c.query(
          "UPDATE role SET permissions = '{people.person.read,platform.user.manage}' WHERE id = $1",
          [ROLE_PLAIN],
        ),
      ),
    ).rejects.toThrow(/never held with user or role management/);
    // The owner turning a role they hold into the silo role (self-appointment by editing).
    const edit = asOwnerRole((c) =>
      c.query("UPDATE role SET permissions = '{safety.speak_up.manage}' WHERE id = $1", [
        ROLE_OWNER,
      ]),
    );
    await edit.then(
      (result) => expect(result.rowCount).toBe(0),
      (error: Error) =>
        expect(error.message).toMatch(/appoints themselves|row-level security|permission denied/),
    );
    const owner = await ownerDb((c) =>
      c.query<{ permissions: string[] }>("SELECT permissions FROM role WHERE id = $1", [
        ROLE_OWNER,
      ]),
    );
    expect(owner.rows[0]?.permissions).toContain("platform.user.manage");
  });

  it("lets a member who manages users appoint and remove the lead, never themselves (L5)", async () => {
    const appointed = await asOwnerRole((c) =>
      c.query<{ changed: boolean }>("SELECT app.set_speak_up_lead($1, true) AS changed", [SPARE]),
    );
    expect(appointed.rows[0]?.changed).toBe(true);
    const leadNow = await as(SPARE)((c) => c.query("SELECT app.speak_up_lead() AS lead"));
    expect(leadNow.rows[0]?.lead).toBe(true);
    const removed = await asOwnerRole((c) =>
      c.query<{ changed: boolean }>("SELECT app.set_speak_up_lead($1, false) AS changed", [SPARE]),
    );
    expect(removed.rows[0]?.changed).toBe(true);
    const leadAfter = await as(SPARE)((c) => c.query("SELECT app.speak_up_lead() AS lead"));
    expect(leadAfter.rows[0]?.lead).toBe(false);
    await expect(
      asOwnerRole((c) => c.query("SELECT app.set_speak_up_lead($1, true)", [a.manager])),
    ).rejects.toThrow(/appoints themselves/);
    await expect(
      asReporter((c) => c.query("SELECT app.set_speak_up_lead($1, true)", [SPARE])),
    ).rejects.toThrow(/Only a member who manages users/);
  });
});

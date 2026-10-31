import { createHash, randomBytes, randomUUID } from "node:crypto";
import { builtinRole } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The speak-up silo in the database (Phase 2 slice 24; SAFE-012; ADR-0089; migration 0086). Only
 * the Freedom to Speak Up lead, members named on a case and the reporter of a named or confidential
 * concern read it; a public request reads one anonymous concern by its reply token's hash. No wider
 * role reaches it: not the owner, not the Registered Manager, not another organisation. The silo
 * guards keep the lead's permission out of mixed roles, grants, self-appointment and user or role
 * management. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const GUARDIAN = "0199f000-0000-7000-8000-0000000003c1";
const ROLE_GUARDIAN = "0199f000-0000-7000-8000-0000000005c1";
const ROLE_OWNER = "0199f000-0000-7000-8000-0000000005c2";
const ROLE_RM = "0199f000-0000-7000-8000-0000000005c3";
const ROLE_QUALITY = "0199f000-0000-7000-8000-0000000005c4";
const QUALITY_LEAD = "0199f000-0000-7000-8000-0000000003c2";
const app = () => db.pool("harbour_app");
const as =
  (userId: string, scope: "tenant" | "locations" = "tenant", tenant = TENANT_A) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
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
  (replyTokenHash: string | null) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), { ...ctx(TENANT_A, null, "none"), speakUp: { replyTokenHash } }, fn);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const newToken = () => randomBytes(32).toString("base64url");
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const count = async (run: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>, table: string) =>
  run(async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n));

/** Raises a named or confidential concern and claims it, in one transaction, as the reporter. */
async function raise(identity: "named" | "confidential"): Promise<string> {
  return asReporter(async (c) => {
    // A client id, never RETURNING: the read policy runs before the new row has a transaction id.
    const id = randomUUID();
    await c.query(
      `INSERT INTO speak_up_concern (id, identity, category, summary, received_on, created_by, updated_by)
       VALUES ($1, $2, 'conduct', 'A colleague shouts at residents at night.', current_date, NULL, NULL)`,
      [id, identity],
    );
    await c.query("INSERT INTO speak_up_reporter (concern_id, tenant_user_id) VALUES ($1, $2)", [
      id,
      a.carer,
    ]);
    await c.query(
      "INSERT INTO speak_up_message (concern_id, from_reporter, body) VALUES ($1, true, 'It happened twice this week.')",
      [id],
    );
    return id;
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Gail Guardian', 'gail.guardian@example.invalid', 'active'),
              ($2, 'Quinn Quality', 'quinn.quality@example.invalid', 'active')`,
      [GUARDIAN, QUALITY_LEAD],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'test_guardian', 'Freedom to Speak Up lead', 'tenant', '{safety.speak_up.manage}'),
         ($2, 'test_owner', 'Owner', 'tenant', $4),
         ($3, 'test_rm', 'Registered Manager', 'location', $5),
         ($6, 'test_quality', 'Quality lead', 'tenant', $7)`,
      [
        ROLE_GUARDIAN,
        ROLE_OWNER,
        ROLE_RM,
        builtinRole("owner")?.permissions,
        builtinRole("registered_manager")?.permissions,
        ROLE_QUALITY,
        builtinRole("quality_lead")?.permissions,
      ],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, NULL), ($5, $6, $7), ($8, $9, NULL)`,
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
    ] as const) {
      for (const table of [
        "speak_up_concern",
        "speak_up_reporter",
        "speak_up_message",
        "speak_up_case_member",
      ]) {
        expect(await count(run, table), `${who} reads ${table}`).toBe(0);
      }
    }
    expect(await count(as(ids.b.manager, "tenant", TENANT_B), "speak_up_concern")).toBe(0);
  });

  it("never lets a member claim someone else's concern as its reporter", async () => {
    const id = await raise("confidential");
    await expect(
      asManager((c) =>
        c.query("INSERT INTO speak_up_reporter (concern_id, tenant_user_id) VALUES ($1, $2)", [
          id,
          a.northManager,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("never stores who created a concern", async () => {
    await expect(
      asReporter((c) =>
        c.query(
          `INSERT INTO speak_up_concern (identity, category, summary, received_on)
           VALUES ('named', 'other', 'The rota is unsafe.', current_date)`,
        ),
      ),
    ).rejects.toThrow(/row-level security|speak_up_concern_no_creator/);
  });

  it("opens an anonymous concern only to a public request with its reply token, and the lead", async () => {
    const token = newToken();
    await asPublic(null)((c) =>
      c.query(
        `INSERT INTO speak_up_concern (identity, category, summary, received_on, reply_token_hash,
           created_by, updated_by)
         VALUES ('anonymous', 'care_quality_or_safety', 'Night checks are skipped.', current_date,
           $1, NULL, NULL)`,
        [hashOf(token)],
      ),
    );
    expect(await count(asPublic(hashOf(token)), "speak_up_concern")).toBe(1);
    expect(await count(asPublic(hashOf(newToken())), "speak_up_concern")).toBe(0);
    expect(await count(asPublic(null), "speak_up_concern")).toBe(0);
    // A member's own session never raises an anonymous concern (it would carry who they are).
    await expect(
      asReporter((c) =>
        c.query(
          `INSERT INTO speak_up_concern (identity, category, summary, received_on, created_by, updated_by)
           VALUES ('anonymous', 'other', 'Something is wrong.', current_date, NULL, NULL)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // The reporter replies with the token; nobody but the lead and the token sees it.
    await asPublic(hashOf(token))(async (c) => {
      const { rows } = await c.query<{ id: string }>("SELECT id FROM speak_up_concern");
      await c.query(
        "INSERT INTO speak_up_message (concern_id, from_reporter, body) VALUES ($1, true, 'Still happening.')",
        [rows[0]?.id],
      );
    });
    expect(await count(asPublic(hashOf(token)), "speak_up_message")).toBe(1);
    expect(await count(asOwnerRole, "speak_up_concern")).toBe(0);
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
    // Members cannot name more members, nor change the concern.
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
    // The owner (who manages users and roles) appointing themselves, or being appointed.
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
    // And the lead never gains user or role management.
    await expect(
      ownerDb((c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          GUARDIAN,
          ROLE_OWNER,
        ]),
      ),
    ).rejects.toThrow(/never held with user or role management/);
  });
});

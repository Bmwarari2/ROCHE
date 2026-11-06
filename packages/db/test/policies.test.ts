import { POLICY_WORKFLOW } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POLICY_VERSION_STATES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The policy library and read-and-sign in the database (quality.md section 19; QUAL-008; hazard
 * HZ-128; migration 0087): cross-tenant denial; drafts only for holders of quality.policy.manage;
 * one draft and at most one published version per policy; publishing in the publisher's own name,
 * never by the author where a second reviewer is needed, superseding the last; a published version
 * fixed but for its state; signatures only on the version in force, in one's own name, never
 * changed.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** The quality lead: manages policies across the organisation. */
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** The North House manager: manages policies at North House. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** A care worker: reads and signs. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const FIRE = "0199f300-0000-7000-8000-0000000000a1";
const MEDS = "0199f300-0000-7000-8000-0000000000a2";
const FIRE_V1 = "0199f300-0000-7000-8000-0000000000b1";
const FIRE_V2 = "0199f300-0000-7000-8000-0000000000b2";
const MEDS_V1 = "0199f300-0000-7000-8000-0000000000b3";
const DRAFT_ONLY = "0199f300-0000-7000-8000-0000000000a3";
const DRAFT_ONLY_V1 = "0199f300-0000-7000-8000-0000000000b4";
const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);

const draft = (c: pg.PoolClient, id: string, policyId: string, change = "major") =>
  c.query(
    `INSERT INTO policy_version (id, policy_id, change, change_summary, body, roles, review_due_on)
     VALUES ($1, $2, $3, 'First issue', 'Evacuate by the nearest safe exit.', '{care_worker}', DATE '2099-01-01')`,
    [id, policyId, change],
  );
const publish = (c: pg.PoolClient, id: string, by: string) =>
  c.query("UPDATE policy_version SET state = 'published', published_by = $2 WHERE id = $1", [
    id,
    by,
  ]);
const state = (id: string) =>
  asLead(
    async (c) =>
      (await c.query<{ state: string }>("SELECT state FROM policy_version WHERE id = $1", [id]))
        .rows[0]?.state,
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f300-0000-7000-8000-000000000501', 'quality_lead', 'Quality lead', 'tenant',
          '{quality.policy.manage}'),
         ('0199f300-0000-7000-8000-000000000502', 'registered_manager', 'Registered Manager',
          'location', '{quality.policy.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f300-0000-7000-8000-000000000501', NULL),
         ($2, '0199f300-0000-7000-8000-000000000502', $3),
         ($4, $5, $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer, a.roleCarer],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199f300-0000-7000-8000-000000000503', 'quality_lead', 'Quality lead', 'tenant',
         '{quality.policy.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199f300-0000-7000-8000-000000000503')`,
      [b.manager],
    );
  });
  await asLead(async (c) => {
    await c.query(
      `INSERT INTO policy (id, policy_key, title) VALUES ($1, 'fire_safety', 'Fire safety')`,
      [FIRE],
    );
    await c.query(
      `INSERT INTO policy (id, policy_key, title, require_second_reviewer)
       VALUES ($1, 'medicines', 'Medicines', true)`,
      [MEDS],
    );
    await draft(c, FIRE_V1, FIRE);
    await draft(c, MEDS_V1, MEDS);
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("the policy schema is in step with packages/domain", () => {
  it("lists the version states", () => {
    expect([...POLICY_VERSION_STATES]).toEqual([...POLICY_WORKFLOW.states]);
  });
});

describe("hazard HZ-011 policies stay in their organisation", () => {
  it("never shows another organisation's policies, versions or signatures", async () => {
    const seen = await asOtherTenant(async (c) => ({
      policies: await count(c, "SELECT count(*) AS n FROM policy"),
      versions: await count(c, "SELECT count(*) AS n FROM policy_version"),
    }));
    expect(seen).toEqual({ policies: 0, versions: 0 });
  });
});

describe("hazard HZ-128 policy versions (quality.md section 19)", () => {
  it("hazard HZ-128 shows drafts only to holders of quality.policy.manage", async () => {
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM policy_version"))).toBe(0);
    expect(await asLead((c) => count(c, "SELECT count(*) AS n FROM policy_version"))).toBe(2);
    await expect(asCarer((c) => draft(c, FIRE_V2, FIRE))).rejects.toThrow(/row-level security/);
  });

  it("hazard HZ-128 keeps one draft per policy", async () => {
    await expect(asLead((c) => draft(c, FIRE_V2, FIRE))).rejects.toThrow(/one_draft/);
  });

  it("hazard HZ-128 is published only in the publisher's own name, by a holder of manage", async () => {
    await expect(asLead((c) => publish(c, FIRE_V1, a.northManager))).rejects.toThrow(/own name/);
    const changed = await asCarer(async (c) => (await publish(c, FIRE_V1, a.carer)).rowCount);
    expect(changed).toBe(0);
    await asLead((c) => publish(c, FIRE_V1, a.manager));
    expect(await state(FIRE_V1)).toBe("published");
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM policy_version"))).toBe(1);
  });

  it("hazard HZ-128 is never published by its author when the policy needs a second reviewer", async () => {
    await expect(asLead((c) => publish(c, MEDS_V1, a.manager))).rejects.toThrow(
      /other than its author/,
    );
    await asNorth((c) => publish(c, MEDS_V1, a.northManager));
    expect(await state(MEDS_V1)).toBe("published");
  });

  it("hazard HZ-128 fixes a published version but for its state", async () => {
    await expect(
      asLead((c) =>
        c.query("UPDATE policy_version SET body = 'Use the lift.' WHERE id = $1", [FIRE_V1]),
      ),
    ).rejects.toThrow(/cannot change like that/);
    await expect(
      asLead((c) =>
        c.query("UPDATE policy_version SET state = 'superseded' WHERE id = $1", [FIRE_V1]),
      ),
    ).rejects.toThrow(/cannot change like that/);
  });

  it("hazard HZ-128 supersedes the version in force when the next is published, leaving one", async () => {
    await asLead(async (c) => {
      await draft(c, FIRE_V2, FIRE, "minor");
      await publish(c, FIRE_V2, a.manager);
    });
    expect(await state(FIRE_V1)).toBe("superseded");
    expect(await state(FIRE_V2)).toBe("published");
    expect(
      await asCarer((c) =>
        count(
          c,
          "SELECT count(*) AS n FROM policy_version WHERE policy_id = $1 AND state = 'published'",
          [FIRE],
        ),
      ),
    ).toBe(1);
  });

  it("hazard HZ-128 refuses a review date on or before the day of publication", async () => {
    await asLead((c) =>
      c.query(
        `INSERT INTO policy_version (policy_id, change, change_summary, body, roles, review_due_on)
         VALUES ($1, 'major', 'Rewritten', 'New text', '{care_worker}', DATE '2000-01-01')`,
        [MEDS],
      ),
    );
    await expect(
      asNorth((c) =>
        c.query(
          "UPDATE policy_version SET state = 'published', published_by = $2 WHERE policy_id = $1 AND state = 'draft'",
          [MEDS, a.northManager],
        ),
      ),
    ).rejects.toThrow(/review date after today/);
  });

  it("hazard HZ-128 never lets a statement supersede the version in force by setting the flag itself", async () => {
    await expect(
      asLead(async (c) => {
        await c.query("SELECT set_config('app.policy_superseding', $1, true)", [FIRE]);
        await c.query("UPDATE policy_version SET state = 'superseded' WHERE id = $1", [FIRE_V2]);
      }),
    ).rejects.toThrow(/cannot change like that/);
    expect(await state(FIRE_V2)).toBe("published");
  });

  it("hides a policy that has only a draft, and draft history, from staff who do not manage policies", async () => {
    await asLead(async (c) => {
      await c.query(
        "INSERT INTO policy (id, policy_key, title) VALUES ($1, 'restructure', 'Restructure')",
        [DRAFT_ONLY],
      );
      await draft(c, DRAFT_ONLY_V1, DRAFT_ONLY);
      await c.query("UPDATE policy_version SET change_summary = 'Second draft' WHERE id = $1", [
        DRAFT_ONLY_V1,
      ]);
    });
    expect(
      await asCarer((c) =>
        count(c, "SELECT count(*) AS n FROM policy WHERE id = $1", [DRAFT_ONLY]),
      ),
    ).toBe(0);
    const history = (fn: typeof asLead) =>
      fn((c) =>
        count(c, "SELECT count(*) AS n FROM record_version WHERE record_id = $1", [DRAFT_ONLY_V1]),
      );
    expect(await history(asLead)).toBe(1);
    expect(await history(asCarer)).toBe(0);
  });

  it("never deletes a version", async () => {
    await expect(
      asOwner(TENANT_A, (c) => c.query("DELETE FROM policy_version WHERE id = $1", [FIRE_V1])),
    ).rejects.toThrow();
  });
});

describe("hazard HZ-128 read-and-sign (quality.md section 19)", () => {
  const sign = (c: pg.PoolClient, version: string, signer?: string) =>
    c.query(
      "INSERT INTO policy_signature (policy_version_id, signer_id) VALUES ($1, COALESCE($2, app.current_user_id()))",
      [version, signer ?? null],
    );

  it("hazard HZ-128 signs only the version in force", async () => {
    await expect(asCarer((c) => sign(c, FIRE_V1))).rejects.toThrow(/row-level security/);
    await asCarer((c) => sign(c, FIRE_V2));
  });

  it("hazard HZ-128 signs only in one's own name", async () => {
    await expect(asLead((c) => sign(c, MEDS_V1, a.carer))).rejects.toThrow(/row-level security/);
  });

  it("hazard HZ-128 never changes or deletes a signature", async () => {
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query("UPDATE policy_signature SET signed_at = now() - interval '1 year'"),
      ),
    ).rejects.toThrow();
    await expect(
      asOwner(TENANT_A, (c) => c.query("DELETE FROM policy_signature")),
    ).rejects.toThrow();
  });

  it("shows members their own signatures and managers everyone's", async () => {
    await asNorth((c) => sign(c, FIRE_V2));
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM policy_signature"))).toBe(1);
    expect(await asLead((c) => count(c, "SELECT count(*) AS n FROM policy_signature"))).toBe(2);
  });
});

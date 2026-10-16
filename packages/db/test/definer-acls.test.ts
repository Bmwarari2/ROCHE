import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";

/**
 * Every SECURITY DEFINER function runs with its owner's rights, so who may execute it is the
 * whole of its access control (ADR-0002). Migrated as production is (by harbour_owner, never a
 * superuser), no definer function may be executable by PUBLIC, and each may be executed only by
 * the roles listed here, besides its owner. A new definer function fails this test until it is
 * listed, so its execute rights are decided, not inherited. Trigger functions are left out: they
 * can only run as triggers, never be called.
 */

const EXECUTE: Readonly<Record<string, readonly string[]>> = {
  "app.accept_invitation": ["harbour_app"],
  "app.admit_handed_over_entry": ["harbour_app"],
  "app.auth_user_has_membership": ["harbour_invitation_owner"],
  "app.claim_invitation": ["harbour_app"],
  "app.evidence_pack_link_for_token": ["harbour_app"],
  "app.family_can_see": ["harbour_app", "harbour_owner"],
  "app.family_item_shown": ["harbour_app", "harbour_owner"],
  "app.invitation_for_token": ["harbour_app"],
  "app.invite_first_owner": ["harbour_operator"],
  "app.memberships_for_auth_user": ["harbour_app"],
  "app.provision_tenant": ["harbour_operator"],
  "app.record_invitation_sign_in": ["harbour_app"],
  "app.seed_discard_reasons": [],
  "app.seed_tenant_discard_reasons": [],
  "app.sweep_expired_invitations": ["harbour_worker"],
  "app.unlinked_invitation_sign_ins": ["harbour_worker"],
  // Sub-processor notices (#95, migration 0067).
  "app.announce_sub_processor_notice": ["harbour_operator"],
  "app.sub_processor_objections": ["harbour_operator"],
  "app.resolve_sub_processor_objection": ["harbour_operator"],
  // Sample data mode (migration 0069).
  "app.sample_people": ["harbour_app", "harbour_owner"],
  "app.remove_sample_batch": ["harbour_app"],
};

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

type Definer = { name: string; owner: string; public: boolean; grantees: string[] };

async function definers(): Promise<Definer[]> {
  const { rows } = await db.pool("harbour_owner").query<Definer>(
    `SELECT n.nspname || '.' || p.proname AS name,
            pg_get_userbyid(p.proowner) AS owner,
            EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public,
            coalesce(array(SELECT DISTINCT pg_get_userbyid(a.grantee)
                             FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                            WHERE a.grantee <> 0 AND a.grantee <> p.proowner
                              AND a.privilege_type = 'EXECUTE'
                            ORDER BY 1)::text[], '{}') AS grantees
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND p.prorettype <> 'trigger'::regtype
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1`,
  );
  return rows;
}

describe("hazard HZ-011 definer functions run only for the roles meant to call them", () => {
  it("has definer functions to check, each listed here", async () => {
    const found = await definers();
    expect(found.length).toBeGreaterThan(10);
    expect(found.map((f) => f.name).filter((name) => !(name in EXECUTE))).toEqual([]);
  });

  it("lets PUBLIC execute none of them", async () => {
    expect((await definers()).filter((f) => f.public).map((f) => f.name)).toEqual([]);
  });

  it("lets only the listed roles execute each, besides its owner", async () => {
    for (const f of await definers()) {
      expect({ name: f.name, grantees: f.grantees }).toEqual({
        name: f.name,
        grantees: [...(EXECUTE[f.name] ?? [])].sort(),
      });
    }
  });
});

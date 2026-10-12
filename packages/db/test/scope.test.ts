import {
  type AccessGrantInput,
  type Permission,
  type RoleAssignmentInput,
  resolveAccess,
  type ScopeKind,
  scopeFor,
} from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * Attribute-based scoping enforced again by Postgres (section 4): assigned people only for care
 * workers, location scope for location managers, and break-glass access with a justification.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");

async function visiblePeople(context: ReturnType<typeof ctx>): Promise<string[]> {
  return inContext(app(), context, async (c) => {
    const { rows } = await c.query<{ given_name: string }>(
      "SELECT given_name FROM person ORDER BY given_name",
    );
    return rows.map((r) => r.given_name);
  });
}

describe("hazard HZ-011 person scope", () => {
  it("shows a care worker only the people they are assigned to", async () => {
    expect(await visiblePeople(ctx(TENANT_A, ids.a.carer, "assigned"))).toEqual(["Ada"]);
  });

  it("applies the same scope to contacts and allergies", async () => {
    const rows = await inContext(app(), ctx(TENANT_A, ids.a.carer, "assigned"), async (c) => {
      const contacts = await c.query<{ given_name: string }>("SELECT given_name FROM contact");
      const allergies = await c.query<{ substance: string }>("SELECT substance FROM allergy");
      return {
        contacts: contacts.rows.map((r) => r.given_name),
        allergies: allergies.rows.map((r) => r.substance),
      };
    });
    expect(rows).toEqual({ contacts: ["Eve"], allergies: ["Penicillin"] });
  });

  it("shows a location manager the people at their locations", async () => {
    expect(
      await visiblePeople(ctx(TENANT_A, ids.a.northManager, "locations", [ids.a.locationNorth])),
    ).toEqual(["Ada", "Ben"]);
  });

  it("shows a tenant-wide role everyone in the tenant", async () => {
    expect(await visiblePeople(ctx(TENANT_A, ids.a.manager, "tenant"))).toEqual([
      "Ada",
      "Ben",
      "Cara",
    ]);
  });

  it("shows nothing when the scope is none", async () => {
    expect(await visiblePeople(ctx(TENANT_A, ids.a.carer, "none"))).toEqual([]);
  });

  it("stops showing a person when the assignment has expired", async () => {
    await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        `INSERT INTO person_assignment (tenant_user_id, person_id, valid_from, valid_to)
         VALUES ($1, $2, now() - interval '2 days', now() - interval '1 day')`,
        [ids.a.carer, ids.a.personBen],
      ),
    );
    expect(await visiblePeople(ctx(TENANT_A, ids.a.carer, "assigned"))).toEqual(["Ada"]);
  });

  it("stops a care worker creating people", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.carer, "assigned"), (c) =>
        c.query(
          "INSERT INTO person (location_id, given_name, family_name) VALUES ($1, 'New', 'Person')",
          [ids.a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("stops a location manager creating people at another location", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.northManager, "locations", [ids.a.locationNorth]), (c) =>
        c.query(
          "INSERT INTO person (location_id, given_name, family_name) VALUES ($1, 'New', 'Person')",
          [ids.a.locationSouth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("stops a care worker assigning themselves to someone", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.carer, "assigned"), (c) =>
        c.query("INSERT INTO person_assignment (tenant_user_id, person_id) VALUES ($1, $2)", [
          ids.a.carer,
          ids.a.personCara,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-011 break-glass access", () => {
  it("opens a person outside scope until the break-glass record expires", async () => {
    const carer = ctx(TENANT_A, ids.a.carer, "assigned");
    await inContext(app(), carer, (c) =>
      c.query(
        `INSERT INTO break_glass_event (tenant_user_id, person_id, justification, expires_at)
         VALUES ($1, $2, 'Covering an emergency on South House', now() + interval '1 hour')`,
        [ids.a.carer, ids.a.personCara],
      ),
    );
    expect(await visiblePeople(carer)).toEqual(["Ada", "Cara"]);

    await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query("UPDATE break_glass_event SET expires_at = now() - interval '1 second'"),
    );
    expect(await visiblePeople(carer)).toEqual(["Ada"]);
  });

  it("cannot be opened on behalf of someone else", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, ids.a.carer, "assigned"), (c) =>
        c.query(
          `INSERT INTO break_glass_event (tenant_user_id, person_id, justification, expires_at)
           VALUES ($1, $2, 'Not mine to open', now() + interval '1 hour')`,
          [ids.a.northManager, ids.a.personCara],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-011 data scope per permission (ADR-0071)", () => {
  // Invented staff: Tia is a team leader at North House who also views finance across the
  // organisation; Gil is an administrator at North House acting up at South House by a grant.
  const TIA = "0193a000-0000-7000-8000-0000000003a1";
  const GIL = "0193a000-0000-7000-8000-0000000003a2";
  const roles = {
    teamLeader: "0193a000-0000-7000-8000-0000000005a1",
    financeViewer: "0193a000-0000-7000-8000-0000000005a2",
    administrator: "0193a000-0000-7000-8000-0000000005a3",
  };

  beforeAll(async () => {
    await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status) VALUES
           ($1, 'Tia Twohomes', 'tia.twohomes@example.invalid', 'active'),
           ($2, 'Gil Granted', 'gil.granted@example.invalid', 'active')`,
        [TIA, GIL],
      );
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
           ($1, 'tenant_team_leader', 'Team leader', 'location',
            '{people.person.read,care.note.read,care.note.write}'),
           ($2, 'tenant_finance_viewer', 'Finance viewer', 'tenant', '{finance.reporting.read}'),
           ($3, 'tenant_administrator', 'Administrator', 'location', '{people.demographics.read}')`,
        [roles.teamLeader, roles.financeViewer, roles.administrator],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
           ($1, $3, $5), ($1, $4, NULL), ($2, $6, $5)`,
        [TIA, GIL, roles.teamLeader, roles.financeViewer, ids.a.locationNorth, roles.administrator],
      );
      await c.query(
        `INSERT INTO access_grant
           (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
         VALUES ($1, '{people.person.read,care.note.read,care.note.write}', $2,
                 now() - interval '1 day', now() + interval '1 day', 'Acting up', $3)`,
        [GIL, ids.a.locationSouth, ids.a.manager],
      );
    });
  });

  /** The member's access as the API resolves it: their own role and grant rows, read as them. */
  async function accessOf(userId: string) {
    return inContext(app(), ctx(TENANT_A, userId, "none"), async (c) => {
      const assignments = await c.query<{
        role_key: string;
        scope_kind: ScopeKind;
        permissions: string[];
        location_id: string | null;
        valid_from: Date;
        valid_to: Date | null;
      }>(
        `SELECT r.key AS role_key, r.scope_kind, r.permissions, ra.location_id, ra.valid_from,
                ra.valid_to
         FROM role_assignment ra JOIN role r ON r.id = ra.role_id
         WHERE ra.tenant_user_id = $1 AND ra.deleted_at IS NULL`,
        [userId],
      );
      const grants = await c.query<{
        permissions: string[];
        location_id: string | null;
        valid_from: Date;
        valid_to: Date;
        revoked_at: Date | null;
      }>(
        `SELECT permissions, location_id, valid_from, valid_to, revoked_at FROM access_grant
         WHERE tenant_user_id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      return resolveAccess(
        assignments.rows.map(
          (a): RoleAssignmentInput => ({
            roleKey: a.role_key,
            scopeKind: a.scope_kind,
            permissions: a.permissions,
            locationId: a.location_id,
            validFrom: a.valid_from,
            validTo: a.valid_to,
          }),
        ),
        grants.rows.map(
          (g): AccessGrantInput => ({
            permissions: g.permissions,
            locationId: g.location_id,
            validFrom: g.valid_from,
            validTo: g.valid_to,
            revokedAt: g.revoked_at,
          }),
        ),
        new Date(),
      );
    });
  }

  /** The row-level security context a request using one permission runs under. */
  async function contextFor(userId: string, permission: Permission) {
    const { scope, locationIds } = scopeFor(await accessOf(userId), permission);
    return ctx(TENANT_A, userId, scope, locationIds);
  }

  const writeAllergy = async (userId: string, personId: string) =>
    inContext(app(), await contextFor(userId, "care.note.write"), (c) =>
      c.query(
        "INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Pollen', 'mild')",
        [personId],
      ),
    );

  it("keeps the team leader's care permissions at North House, whatever the finance role reaches", async () => {
    expect(await visiblePeople(await contextFor(TIA, "care.note.read"))).toEqual(["Ada", "Ben"]);
    expect(await visiblePeople(await contextFor(TIA, "people.person.read"))).toEqual([
      "Ada",
      "Ben",
    ]);
    // The finance permission reaches the whole organisation, and only it.
    expect(await contextFor(TIA, "finance.reporting.read")).toMatchObject({ scope: "tenant" });
  });

  it("refuses the team leader's write about someone at South House, and allows one at North House", async () => {
    await expect(writeAllergy(TIA, ids.a.personCara)).rejects.toThrow(/row-level security/);
    await expect(writeAllergy(TIA, ids.a.personBen)).resolves.toBeDefined();
  });

  it("lets a grant reach South House only, and the role's own permission North House only", async () => {
    expect(await visiblePeople(await contextFor(GIL, "care.note.read"))).toEqual(["Cara"]);
    expect(await contextFor(GIL, "people.demographics.read")).toMatchObject({
      scope: "locations",
      locationIds: [ids.a.locationNorth],
    });
    await expect(writeAllergy(GIL, ids.a.personAda)).rejects.toThrow(/row-level security/);
    await expect(writeAllergy(GIL, ids.a.personCara)).resolves.toBeDefined();
  });
});

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

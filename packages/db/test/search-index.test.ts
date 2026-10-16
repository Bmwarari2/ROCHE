import { searchTerms } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The search index (PLAT-013; platform-completions.md rule 2 and section 6; ADR-0070; migration
 * 0066; hazards HZ-001 and HZ-011): `app.search_terms` gives the domain's terms for the same text;
 * every search runs under forced row-level security, so it finds nothing in another tenant or
 * outside the caller's scope; each kind uses its composite index with the tenant as the index
 * condition; and no search function is LEAKPROOF or SECURITY DEFINER.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const as = <T>(context: ReturnType<typeof ctx>, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), context, fn);
const asManager = ctx(TENANT_A, a.manager, "tenant");

/** People whose names match a prefix query, as the API asks: the tenant first, then the vector. */
const people = (context: ReturnType<typeof ctx>, query: string, tenant = context.tenantId) =>
  as(context, (c) =>
    c
      .query<{ given_name: string }>(
        `SELECT given_name FROM person
         WHERE tenant_id = $1 AND search_names @@ to_tsquery('app.harbour_search', $2)
         ORDER BY given_name`,
        [tenant, query],
      )
      .then((r) => r.rows.map((row) => row.given_name)),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  // Another provider has a resident with the same name as Ada.
  await inContext(db.pool("harbour_owner"), ctx(TENANT_B, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO person (location_id, status, given_name, family_name, room_label)
       VALUES ($1, 'active', 'Ada', 'Example', '12')`,
      [ids.b.location],
    );
    // And documents with the same titles as the first provider's.
    await c.query(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type,
         size_bytes, sha256, person_id, file_name)
       VALUES ('person_document', 'Hospital passport', 'care_record', 'k', 'application/pdf', 1,
               repeat('0', 64), $1, 'passport.pdf'),
              ('organisation_document', 'Fire policy', 'policy', 'k', 'application/pdf', 1,
               repeat('0', 64), NULL, NULL)`,
      [ids.b.personDev],
    );
  });
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      "UPDATE person SET room_label = 'Room 12', preferred_name = 'Addie' WHERE id = $1",
      [a.personAda],
    );
    await c.query(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
       VALUES ($1, $2, now(), 'activity', 'Enjoyed the garden with Zoë'),
              ($3, $4, now(), 'activity', 'Garden walk')`,
      [a.personAda, a.locationNorth, a.personCara, a.locationSouth],
    );
    // Ada (north) and Cara (south) each have a hospital passport; the provider has a fire policy.
    await c.query(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type,
         size_bytes, sha256, person_id, file_name)
       VALUES ('person_document', 'Hospital passport', 'care_record', 'k', 'application/pdf', 1,
               repeat('0', 64), $1, 'passport-ada.pdf'),
              ('person_document', 'Hospital passport', 'care_record', 'k', 'application/pdf', 1,
               repeat('0', 64), $2, 'passport-cara.pdf'),
              ('organisation_document', 'Fire policy', 'policy', 'k', 'application/pdf', 1,
               repeat('0', 64), NULL, NULL)`,
      [a.personAda, a.personCara],
    );
  });
}, 120_000);

/** Documents whose title or file name matches, as the API asks: the tenant first. */
const documents = (context: ReturnType<typeof ctx>, query: string, tenant = context.tenantId) =>
  as(context, (c) =>
    c
      .query<{ title: string; person_id: string | null }>(
        `SELECT title, person_id FROM document
         WHERE tenant_id = $1 AND search_title @@ to_tsquery('app.harbour_search', $2)
         ORDER BY title, person_id`,
        [tenant, query],
      )
      .then((r) => r.rows),
  );

afterAll(async () => {
  await db?.drop();
});

describe("search terms match the domain's normalisation (rule 2)", () => {
  it.each([
    "Ada Example",
    "O'Brien",
    "O’Brien",
    "Zoë Éxample",
    "Smith-Example",
    "Straße Ørsted Łukasz",
    "  room 12  ",
    "ada@example.invalid",
    "ＡＤＡ",
    "Ada % Example",
    "' - ! ?",
    "Æsir þór ðe",
    "ﬁne",
  ])("%s", async (text) => {
    const [row] = await as(asManager, (c) =>
      c
        .query<{ terms: string[] }>("SELECT app.search_terms($1) AS terms", [text])
        .then((r) => r.rows),
    );
    expect(row?.terms).toEqual(searchTerms(text));
  });
});

describe("hazard HZ-011 search stays inside the tenant and the caller's scope", () => {
  it("finds a person by name, preferred name and accent-free prefix, only in this tenant", async () => {
    expect(await people(asManager, "ada:*")).toEqual(["Ada"]);
    expect(await people(asManager, "addie:*")).toEqual(["Ada"]);
    expect(await people(asManager, "exam:* & ad:*")).toEqual(["Ada"]);
  });

  it("finds nothing from another tenant, even when the tenant id in the query is another's", async () => {
    expect(await people(asManager, "ada:*", TENANT_B)).toEqual([]);
    expect(await people(ctx(TENANT_B, ids.b.manager, "tenant"), "ada:*")).toEqual(["Ada"]);
  });

  it("finds document titles only in this tenant and, about people, only in scope", async () => {
    // The tenant's own documents: both passports and the policy, never the other provider's.
    expect(await documents(asManager, "hospital:* | fire:*")).toEqual([
      { title: "Fire policy", person_id: null },
      ...[a.personAda, a.personCara]
        .sort()
        .map((id) => ({ title: "Hospital passport", person_id: id })),
    ]);
    expect(await documents(asManager, "passport:*", TENANT_B)).toEqual([]);
    // By file name too, and only Ada's at the north location; Cara's is at the south.
    expect(
      await documents(ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), "passport:*"),
    ).toEqual([{ title: "Hospital passport", person_id: a.personAda }]);
    expect(await documents(ctx(TENANT_A, a.carer, "assigned"), "cara:*")).toEqual([]);
    expect(await documents(ctx(TENANT_A, a.manager, "none"), "passport:*")).toEqual([]);
  });

  it("finds nothing outside scope: assigned people, other locations, or no scope", async () => {
    expect(await people(ctx(TENANT_A, a.carer, "assigned"), "ben:* | ada:*")).toEqual(["Ada"]);
    expect(
      await people(ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), "cara:*"),
    ).toEqual([]);
    expect(await people(ctx(TENANT_A, a.manager, "none"), "ada:*")).toEqual([]);
  });

  it("indexes rooms, colleagues, document titles and notes under the same policies", async () => {
    const found = await as(ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), (c) =>
      Promise.all([
        c.query(
          "SELECT id FROM person WHERE tenant_id = $1 AND search_room @@ to_tsquery('app.harbour_search', '12')",
          [TENANT_A],
        ),
        c.query(
          "SELECT id FROM tenant_user WHERE tenant_id = $1 AND search_name @@ to_tsquery('app.harbour_search', 'cat:*')",
          [TENANT_A],
        ),
        c.query(
          "SELECT person_id FROM care_note WHERE tenant_id = $1 AND search_body @@ to_tsquery('app.harbour_search', 'garden & zoe')",
          [TENANT_A],
        ),
        c.query(
          "SELECT person_id FROM care_note WHERE tenant_id = $1 AND search_body @@ to_tsquery('app.harbour_search', 'garden')",
          [TENANT_A],
        ),
      ]),
    );
    const [rooms, staff, notes, garden] = found.map((r) => r.rows);
    expect(rooms).toEqual([{ id: a.personAda }]);
    // Colleagues: this tenant's Cat Carer only, never the other provider's.
    expect(staff).toEqual([{ id: a.carer }]);
    expect(notes).toEqual([{ person_id: a.personAda }]);
    // Cara's note is at the south location: outside this manager's scope.
    expect(garden).toEqual([{ person_id: a.personAda }]);
  });
});

/**
 * Under forced row-level security only a leakproof condition can be an index condition ahead of the
 * policy. Equality on the tenant is, so every search reads by an index on the tenant; the
 * full-text match is not, so it is a filter applied with the policy, within the caller's own rows
 * (ADR-0070 point 4). The text is never matched against rows the policy would hide.
 */
describe("each search reads by the tenant first and matches the text only within the policy (ADR-0070)", () => {
  it.each([
    ["person", "search_names"],
    ["person", "search_room"],
    ["tenant_user", "search_name"],
    ["document", "search_title"],
    ["care_note", "search_body"],
  ])("%s.%s", async (table, column) => {
    const plan = await as(asManager, async (c) => {
      await c.query("SET LOCAL enable_seqscan = off");
      const r = await c.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM ${table} WHERE tenant_id = $1 AND ${column} @@ to_tsquery('app.harbour_search', 'ada:*')`,
        [TENANT_A],
      );
      return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/Index Cond: \(tenant_id = /);
    expect(plan).not.toMatch(new RegExp(`Index Cond: [^\\n]*${column}`));
    expect(plan).toMatch(new RegExp(`Filter: [^\\n]*${column} @@`));
  });
});

describe("no search function is a shortcut past row-level security", () => {
  it("app.search_terms and app.search_vector are SECURITY INVOKER and not LEAKPROOF", async () => {
    const rows = await as(asManager, (c) =>
      c
        .query<{ name: string; leakproof: boolean; definer: boolean; volatility: string }>(
          `SELECT p.proname AS name, p.proleakproof AS leakproof, p.prosecdef AS definer,
                  p.provolatile AS volatility
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'app' AND p.proname LIKE 'search%' ORDER BY p.proname`,
        )
        .then((r) => r.rows),
    );
    expect(rows).toEqual([
      { name: "search_terms", leakproof: false, definer: false, volatility: "i" },
      { name: "search_vector", leakproof: false, definer: false, volatility: "i" },
    ]);
  });
});

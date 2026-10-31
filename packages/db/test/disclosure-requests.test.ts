import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Disclosure requests in the database (SAFE-016; safety.md section 11; migration 0103; hazard
 * HZ-011): read and worked only by holders at the person's location or across the organisation;
 * logged in one's own name; approved only by a holder of safety.disclosure.approve who did not log
 * it; frozen once released, refused or withdrawn (bar a coroner's Regulation 28 dates); items
 * decided only while the request is worked; read by the system for the export, never written.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_HOME = "0199f000-0000-7000-8000-000000000c01";
const ROLE_ORG = "0199f000-0000-7000-8000-000000000c02";
const app = () => db.pool("harbour_app");
const asHome = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
const asOther = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);

const LOG = `INSERT INTO disclosure_request (person_id, location_id, type, legal_basis, requester_name,
    requester_organisation, received_at)
  VALUES ($1, $2, 'coroner', 'Coroners and Justice Act 2009, Schedule 5', 'Coroner''s officer',
    'HM Coroner (example)', now()) RETURNING id`;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'home_disclosure', 'Home manager', 'location', '{safety.incident.manage,safety.disclosure.approve}'),
         ($2, 'org_disclosure', 'Organisation lead', 'tenant', '{safety.incident.manage,safety.disclosure.approve}')`,
      [ROLE_HOME, ROLE_ORG],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.northManager, ROLE_HOME, a.locationNorth],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_ORG,
    ]);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 disclosure requests (migration 0103)", () => {
  it("is logged at the person's location by a manager there, in their own name, and by no one else", async () => {
    const { rows } = await asHome((c) =>
      c.query<{ id: string }>(LOG, [a.personAda, a.locationNorth]),
    );
    expect(rows).toHaveLength(1);
    // Another home's person is beyond the home manager.
    await expect(asHome((c) => c.query(LOG, [a.personCara, a.locationSouth]))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asCarer((c) => c.query(LOG, [a.personAda, a.locationNorth]))).rejects.toThrow(
      /row-level security/,
    );
    expect((await asCarer((c) => c.query("SELECT id FROM disclosure_request"))).rowCount).toBe(0);
    expect((await asOther((c) => c.query("SELECT id FROM disclosure_request"))).rowCount).toBe(0);
    // The organisation lead sees it; so does the system (the full export), which never writes.
    expect((await asLead((c) => c.query("SELECT id FROM disclosure_request"))).rowCount).toBe(1);
    expect((await asSystem((c) => c.query("SELECT id FROM disclosure_request"))).rowCount).toBe(1);
    await expect(asSystem((c) => c.query(LOG, [a.personAda, a.locationNorth]))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asHome((c) => c.query("DELETE FROM disclosure_request"))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("is approved only by someone else holding safety.disclosure.approve, and is frozen once released", async () => {
    const { rows } = await asHome((c) =>
      c.query<{ id: string }>(LOG, [a.personAda, a.locationNorth]),
    );
    const id = rows[0]?.id;
    // Items are decided while the request is worked, by the reviewer in their own name.
    const item = await asHome((c) =>
      c.query<{ id: string }>(
        "INSERT INTO disclosure_item (request_id, table_name, record_id) VALUES ($1, 'person', $2) RETURNING id",
        [id, a.personAda],
      ),
    );
    await expect(
      asHome((c) =>
        c.query(
          `UPDATE disclosure_item SET decision = 'disclose', reviewed_by = $2, reviewed_at = now(),
             content_sha256 = repeat('a', 64) WHERE id = $1`,
          [item.rows[0]?.id, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await asHome((c) =>
      c.query(
        `UPDATE disclosure_item SET decision = 'disclose', reviewed_by = $2, reviewed_at = now(),
           content_sha256 = repeat('a', 64) WHERE id = $1`,
        [item.rows[0]?.id, a.northManager],
      ),
    );
    await asHome((c) =>
      c.query(
        "UPDATE disclosure_request SET state = 'prepared', prepared_by = $2, prepared_at = now() WHERE id = $1",
        [id, a.northManager],
      ),
    );
    // The person who logged it may not approve it.
    await expect(
      asHome((c) =>
        c.query(
          "UPDATE disclosure_request SET state = 'approved', decided_by = $2, decided_at = now() WHERE id = $1",
          [id, a.northManager],
        ),
      ),
    ).rejects.toThrow(/disclosure_request_approver/);
    // Nor may anyone approve in another's name.
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE disclosure_request SET state = 'approved', decided_by = $2, decided_at = now() WHERE id = $1",
          [id, a.carer],
        ),
      ),
    ).rejects.toThrow(/disclosure_approver_not_you/);
    await asLead((c) =>
      c.query(
        "UPDATE disclosure_request SET state = 'approved', decided_by = $2, decided_at = now() WHERE id = $1",
        [id, a.manager],
      ),
    );
    await asHome((c) =>
      c.query(
        `UPDATE disclosure_request SET state = 'released', released_by = $2, released_at = now(),
           pack_sha256 = repeat('b', 64), pack_storage_key = 'disclosures/x' WHERE id = $1`,
        [id, a.northManager],
      ),
    );
    await expect(
      asHome((c) =>
        c.query("UPDATE disclosure_request SET requester_name = 'Changed' WHERE id = $1", [id]),
      ),
    ).rejects.toThrow(/disclosure_closed/);
    // A coroner's Regulation 28 report and response may still be recorded.
    await asHome((c) =>
      c.query(
        "UPDATE disclosure_request SET prevention_report_on = current_date, prevention_responded_on = current_date WHERE id = $1",
        [id],
      ),
    );
    // Items are fixed once the request has moved on.
    await expect(
      asHome((c) =>
        c.query("UPDATE disclosure_item SET decision = 'pending' WHERE id = $1", [
          item.rows[0]?.id,
        ]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("keeps a request's history from those who may not read the request", async () => {
    const { rows } = await asHome((c) =>
      c.query<{ id: string }>(LOG, [a.personAda, a.locationNorth]),
    );
    await asHome((c) =>
      c.query("UPDATE disclosure_request SET requester_reference = 'REF-1' WHERE id = $1", [
        rows[0]?.id,
      ]),
    );
    const history =
      "SELECT id FROM record_version WHERE table_name = 'disclosure_request' AND record_id = $1";
    expect((await asHome((c) => c.query(history, [rows[0]?.id]))).rowCount).toBe(1);
    expect((await asLead((c) => c.query(history, [rows[0]?.id]))).rowCount).toBe(1);
    expect((await asCarer((c) => c.query(history, [rows[0]?.id]))).rowCount).toBe(0);
    // Other history stays readable as before.
    const people = await asCarer((c) =>
      c.query(
        "SELECT count(*)::int AS n FROM record_version WHERE table_name <> 'disclosure_request'",
      ),
    );
    expect(people.rows).toHaveLength(1);
  });

  it("needs a stated purpose for police and solicitors before it moves on", async () => {
    const { rows } = await asHome((c) =>
      c.query<{ id: string }>(
        `INSERT INTO disclosure_request (person_id, location_id, type, legal_basis, requester_name,
           requester_organisation, received_at)
         VALUES ($1, $2, 'police', 'Data Protection Act 2018, Schedule 2, paragraph 2', 'DC Example',
           'Example Police', now()) RETURNING id`,
        [a.personAda, a.locationNorth],
      ),
    );
    await expect(
      asHome((c) =>
        c.query(
          "UPDATE disclosure_request SET state = 'prepared', prepared_by = $2, prepared_at = now() WHERE id = $1",
          [rows[0]?.id, a.northManager],
        ),
      ),
    ).rejects.toThrow(/disclosure_request_purpose/);
  });
});

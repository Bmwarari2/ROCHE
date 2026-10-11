import type pg from "pg";
import type { RequestContext } from "../../src/client";

/**
 * Two-tenant fixture for isolation tests. All people are invented ("Ada Example") and NHS numbers
 * come from the 999 test range. Inserts run as harbour_owner, which is itself subject to row-level
 * security (FORCE), so each insert sets the matching tenant context first.
 */

export const TENANT_A = "0193a000-0000-7000-8000-00000000000a";
export const TENANT_B = "0193b000-0000-7000-8000-00000000000b";

export const ids = {
  a: {
    locationNorth: "0193a000-0000-7000-8000-000000000101",
    locationSouth: "0193a000-0000-7000-8000-000000000102",
    service: "0193a000-0000-7000-8000-000000000201",
    manager: "0193a000-0000-7000-8000-000000000301",
    carer: "0193a000-0000-7000-8000-000000000302",
    northManager: "0193a000-0000-7000-8000-000000000303",
    personAda: "0193a000-0000-7000-8000-000000000401",
    personBen: "0193a000-0000-7000-8000-000000000402",
    personCara: "0193a000-0000-7000-8000-000000000403",
    roleCarer: "0193a000-0000-7000-8000-000000000501",
  },
  b: {
    location: "0193b000-0000-7000-8000-000000000101",
    manager: "0193b000-0000-7000-8000-000000000301",
    personDev: "0193b000-0000-7000-8000-000000000401",
  },
} as const;

export const AUTH_USER_SHARED = "auth-shared-agency-worker";

export function ctx(
  tenantId: string,
  userId: string | null,
  scope: RequestContext["scope"],
  locationIds: readonly string[] = [],
): RequestContext {
  return { tenantId, userId, scope, locationIds };
}

/** Runs `fn` in a transaction on one connection with the request context applied. */
export async function inContext<T>(
  pool: pg.Pool,
  context: RequestContext | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (context) {
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', $3, true), set_config('app.location_ids', $4, true)`,
        [context.tenantId, context.userId ?? "", context.scope, context.locationIds.join(",")],
      );
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function seedTwoTenants(owner: pg.Pool): Promise<void> {
  const a = ids.a;
  const b = ids.b;

  await inContext(owner, ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO tenant (id, name, legal_name, legal_form, status)
       VALUES ($1, 'Harbour Demo Care', 'Harbour Demo Care Ltd', 'limited_company', 'active')`,
      [TENANT_A],
    );
    await c.query(
      `INSERT INTO location (id, name, regulator_location_id) VALUES
         ($1, 'North House', '1-000000001'), ($2, 'South House', '1-000000002')`,
      [a.locationNorth, a.locationSouth],
    );
    await c.query(
      `INSERT INTO service (id, location_id, name, service_type)
       VALUES ($1, $2, 'North House nursing', 'nursing')`,
      [a.service, a.locationNorth],
    );
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-a-manager', 'Mo Manager', 'mo.manager@example.invalid', 'active'),
         ($2, $4, 'Cat Carer', 'cat.carer@example.invalid', 'active'),
         ($3, 'auth-a-north', 'Nia North', 'nia.north@example.invalid', 'active')`,
      [a.manager, a.carer, a.northManager, AUTH_USER_SHARED],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin)
       VALUES ($1, 'care_worker', 'Care worker', 'assigned', '{people.person.read}', true)`,
      [a.roleCarer],
    );
    await c.query(
      `INSERT INTO person (id, location_id, status, nhs_number, given_name, family_name, date_of_birth, allergy_status)
       VALUES
         ($1, $4, 'active', '9990000018', 'Ada', 'Example', '1938-02-01', 'has_allergies'),
         ($2, $4, 'active', '9990000026', 'Ben', 'Sample', '1941-07-15', 'no_known_allergies'),
         ($3, $5, 'active', '9990000034', 'Cara', 'Placeholder', '1935-11-30', 'unknown')`,
      [a.personAda, a.personBen, a.personCara, a.locationNorth, a.locationSouth],
    );
    await c.query(
      `INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Penicillin', 'severe')`,
      [a.personAda],
    );
    await c.query(
      `INSERT INTO contact (person_id, role, given_name, family_name, is_next_of_kin) VALUES
         ($1, 'next_of_kin', 'Eve', 'Example', true),
         ($2, 'next_of_kin', 'Finn', 'Sample', true),
         ($3, 'lpa_health_welfare', 'Gus', 'Placeholder', false)`,
      [a.personAda, a.personBen, a.personCara],
    );
    // The carer is assigned to Ada only.
    await c.query(`INSERT INTO person_assignment (tenant_user_id, person_id) VALUES ($1, $2)`, [
      a.carer,
      a.personAda,
    ]);
    await c.query(
      `INSERT INTO feature_flag (flag_key, enabled) VALUES ('module.domiciliary', false)`,
    );
    await c.query(
      `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
       VALUES ($1, 'ecm.tolerance_minutes.low', 20, 'minutes', 'england', '2026-04-01', 'tenant policy', 'tenant')`,
      [TENANT_A],
    );
  });

  await inContext(owner, ctx(TENANT_B, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO tenant (id, name, legal_name, legal_form, status)
       VALUES ($1, 'Other Provider', 'Other Provider CIC', 'community_interest_company', 'active')`,
      [TENANT_B],
    );
    await c.query(`INSERT INTO location (id, name) VALUES ($1, 'Riverside')`, [b.location]);
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-b-manager', 'Bea Boss', 'bea.boss@example.invalid', 'active'),
         (app.uuid_v7(), $2, 'Cat Carer', 'cat.carer@example.invalid', 'active')`,
      [b.manager, AUTH_USER_SHARED],
    );
    await c.query(
      `INSERT INTO person (id, location_id, status, nhs_number, given_name, family_name)
       VALUES ($1, $2, 'active', '9990000042', 'Dev', 'Fixture')`,
      [b.personDev, b.location],
    );
    await c.query(
      `INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Latex', 'moderate')`,
      [b.personDev],
    );
    await c.query(
      `INSERT INTO contact (person_id, role, given_name, family_name) VALUES ($1, 'advocate', 'Hal', 'Fixture')`,
      [b.personDev],
    );
    await c.query(
      `INSERT INTO feature_flag (flag_key, enabled) VALUES ('module.domiciliary', true)`,
    );
  });

  // Global reference row (NULL tenant), maintained by the owner.
  await inContext(owner, null, async (c) => {
    await c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('nmw.hourly.21_plus', 12.71, 'GBP_per_hour', 'uk', '2026-04-01', 'master prompt section 3', 'master-prompt')`,
    );
  });
}

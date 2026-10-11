import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TENANT_HEADER } from "@harbour/contracts";
import {
  DEMO,
  linkDemoUser,
  parseBankHolidays,
  parseRates,
  parseRetention,
  seedDemoTenant,
  seedReferenceData,
} from "@harbour/db/seed";
import { createTestDatabase, type TestDatabase } from "@harbour/db/testing";
import type pg from "pg";
import { type AppHandle, createApp } from "../../src/app";
import { MOBILE_APP_ORIGIN } from "../../src/auth/token-exposure";
import { loadConfig } from "../../src/config";
import { createLogger } from "../../src/logger";

/**
 * Integration harness: a freshly migrated database, the demo tenant plus a second tenant, real
 * Better Auth accounts, and the Hono app exercised through `app.request` (no network).
 */

export const PASSWORD = "correct horse battery staple";

export const OTHER = {
  tenantId: "0194e000-0000-7000-8000-000000000001",
  locationId: "0194e000-0000-7000-8000-000000000101",
  personId: "0194e000-0000-7000-8000-000000000401",
  managerId: "0194e000-0000-7000-8000-000000000301",
  agencyId: "0194e000-0000-7000-8000-000000000302",
};

export const LODGE = {
  locationId: "0194d000-0000-7000-8000-000000000102",
  personId: "0194d000-0000-7000-8000-000000000499",
  qualityLeadId: "0194d000-0000-7000-8000-000000000305",
};

const ACTIVATE = "UPDATE tenant_user SET auth_user_id = $1, status = 'active' WHERE id = $2";

export interface Harness {
  readonly db: TestDatabase;
  readonly handle: AppHandle;
  readonly tokens: Record<string, string>;
  readonly authIds: Record<string, string>;
  request(
    path: string,
    init?: {
      token?: string;
      tenant?: string;
      method?: string;
      body?: unknown;
      origin?: string;
      /** A raw body (file upload) sent with its own content type instead of JSON. */
      raw?: { bytes: Uint8Array; contentType: string };
    },
  ): Promise<Response>;
  close(): Promise<void>;
}

type Statement = readonly [sql: string, params?: unknown[]];

async function ownerTx(pool: pg.Pool, tenantId: string, ...statements: Statement[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenantId],
    );
    for (const [sql, params] of statements) await client.query(sql, params ?? []);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDatabase();
  const owner = db.pool("harbour_owner");
  const specs = fileURLToPath(new URL("../../../../docs/specs/", import.meta.url));
  await seedReferenceData(
    owner,
    parseRates(readFileSync(`${specs}rates.md`, "utf8")),
    parseRetention(readFileSync(`${specs}retention.md`, "utf8")),
    parseBankHolidays(readFileSync(`${specs}calendar.md`, "utf8")),
  );
  await seedDemoTenant(owner);

  // A second location in the demo tenant, outside the Registered Manager's scope, with one person
  // and a quality lead who is told about break-glass access.
  await ownerTx(
    owner,
    DEMO.tenantId,
    ["INSERT INTO location (id, name) VALUES ($1, 'Harbour Lodge')", [LODGE.locationId]],
    [
      `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number)
       VALUES ($1, $2, 'active', 'Gwen', 'Outofscope', '9990000077')`,
      [LODGE.personId, LODGE.locationId],
    ],
    [
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Quinn Quality', 'quality@example.invalid', 'invited')`,
      [LODGE.qualityLeadId],
    ],
    [
      "INSERT INTO role_assignment (tenant_user_id, role_id) SELECT $1, id FROM role WHERE key = 'quality_lead'",
      [LODGE.qualityLeadId],
    ],
  );

  // A second tenant: an agency worker belongs to both.
  await ownerTx(
    owner,
    OTHER.tenantId,
    [
      `INSERT INTO tenant (id, name, legal_name, legal_form, status)
       VALUES ($1, 'Other Provider', 'Other Provider CIC', 'community_interest_company', 'active')`,
      [OTHER.tenantId],
    ],
    ["INSERT INTO location (id, name) VALUES ($1, 'Riverside')", [OTHER.locationId]],
    [
      `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number)
       VALUES ($1, $2, 'active', 'Hal', 'Elsewhere', '9990000085')`,
      [OTHER.personId, OTHER.locationId],
    ],
    [
      `INSERT INTO role (key, name, scope_kind, permissions, is_builtin)
       VALUES ('registered_manager', 'Registered Manager', 'location', '{people.person.read,platform.audit.read}', true)`,
    ],
    [
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Rae River', 'rae@example.invalid', 'invited'), ($2, 'Agency Ash', 'agency@example.invalid', 'invited')`,
      [OTHER.managerId, OTHER.agencyId],
    ],
    [
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'registered_manager'`,
      [OTHER.managerId, OTHER.locationId],
    ],
  );

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_APP_URL: db.url("harbour_app"),
    DATABASE_AUTH_URL: db.url("harbour_auth"),
    DATABASE_OPERATOR_URL: db.url("harbour_operator"),
    LOG_LEVEL: "silent",
    LOCAL_DOCUMENTS_DIR: mkdtempSync(join(tmpdir(), "harbour-documents-")),
  });
  const handle = createApp(config, createLogger("silent"));

  const request: Harness["request"] = (path, init = {}) => {
    const headers = new Headers({
      "content-type": init.raw ? init.raw.contentType : "application/json",
    });
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    if (init.tenant) headers.set(TENANT_HEADER, init.tenant);
    if (init.origin) headers.set("origin", init.origin);
    return Promise.resolve(
      handle.app.request(path, {
        method: init.method ?? "GET",
        headers,
        ...(init.raw
          ? { body: init.raw.bytes }
          : init.body !== undefined
            ? { body: JSON.stringify(init.body) }
            : {}),
      }),
    );
  };

  async function signUp(email: string, name: string): Promise<{ id: string; token: string }> {
    const response = await request("/api/auth/sign-up/email", {
      method: "POST",
      body: { email, password: PASSWORD, name },
    });
    if (response.status !== 200)
      throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
    const body = (await response.json()) as { user: { id: string } };
    // Signs in as the mobile app does: only that origin receives a bearer token.
    const signIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: PASSWORD },
      origin: MOBILE_APP_ORIGIN,
    });
    const token = signIn.headers.get("set-auth-token");
    if (!token) throw new Error("no bearer token returned");
    return { id: body.user.id, token };
  }

  const tokens: Record<string, string> = {};
  const authIds: Record<string, string> = {};
  for (const key of ["owner", "manager", "nurse", "carer"] as const) {
    const user = DEMO.users[key];
    const { id, token } = await signUp(user.email, user.name);
    await linkDemoUser(owner, key, id);
    tokens[key] = token;
    authIds[key] = id;
  }
  const quality = await signUp("quality@example.invalid", "Quinn Quality");
  await ownerTx(owner, DEMO.tenantId, [ACTIVATE, [quality.id, LODGE.qualityLeadId]]);
  tokens.quality = quality.token;
  authIds.quality = quality.id;

  const agency = await signUp("agency@example.invalid", "Agency Ash");
  await ownerTx(owner, OTHER.tenantId, [ACTIVATE, [agency.id, OTHER.agencyId]]);
  await ownerTx(owner, DEMO.tenantId, [
    `INSERT INTO tenant_user (display_name, email, status, auth_user_id)
     VALUES ('Agency Ash', 'agency@example.invalid', 'active', $1)`,
    [agency.id],
  ]);
  tokens.agency = agency.token;

  const rae = await signUp("rae@example.invalid", "Rae River");
  await ownerTx(owner, OTHER.tenantId, [ACTIVATE, [rae.id, OTHER.managerId]]);
  tokens.rae = rae.token;
  authIds.rae = rae.id;

  // Thapsus operators: an admin, a support engineer, and the nurse's identity as an operator without
  // MFA (to prove the operator console refuses it).
  const opsAdmin = await signUp("ops.admin@example.invalid", "Ola Admin");
  const opsSupport = await signUp("ops.support@example.invalid", "Sam Support");
  tokens.opsAdmin = opsAdmin.token;
  tokens.opsSupport = opsSupport.token;
  authIds.opsAdmin = opsAdmin.id;
  authIds.opsSupport = opsSupport.id;
  await owner.query(
    `INSERT INTO operator_user (auth_user_id, display_name, role) VALUES
       ($1, 'Ola Admin', 'admin'), ($2, 'Sam Support', 'support'), ($3, 'Nell as operator', 'support')`,
    [opsAdmin.id, opsSupport.id, authIds.nurse],
  );

  // Simulate completed TOTP enrolment for everyone except the nurse, after the session was issued
  // (with two-factor on, sign-in itself would require the code).
  await db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id <> $1", [authIds.nurse]);

  return {
    db,
    handle,
    tokens,
    authIds,
    request,
    close: async () => {
      await handle.close();
      await db.drop();
    },
  };
}

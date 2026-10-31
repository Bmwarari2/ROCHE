import type { RecordHistory, RiskAssessmentItem } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import {
  createHarness,
  type Harness,
  LODGE,
  markSessionsVerified,
  PASSWORD,
} from "./support/harness";

/**
 * Hazard HZ-024 and security review round 2: a removed (soft-deleted) record's history, and a
 * removed person's, are found only by a reader whose `platform.audit.read` reaches the person
 * through their roles and grants, never by break-glass. Two members of staff, invented:
 * - Mia Twoplaces is a team leader at Harbour House (care plans, no audit log) and the Registered
 *   Manager at Harbour Lodge (audit log there).
 * - Bo Brokeglass holds a role at Harbour House that reads people and care plans and may break the
 *   glass, but not the audit log, and opens the Lodge resident by break-glass.
 */

const MIA = "0194d000-0000-7000-8000-0000000003b1";
const BO = "0194d000-0000-7000-8000-0000000003b2";
const BREAK_GLASS_ROLE = "0194d000-0000-7000-8000-0000000005b1";
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const HOUSE_PERSON = resident(1);
const HOUSE_PERSON_REMOVED = resident(5);

let h: Harness;
const tokens = { mia: "", bo: "" };
type Who = "mia" | "bo" | "manager" | "owner";

const as = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, {
    token: who === "mia" || who === "bo" ? tokens[who] : h.tokens[who],
    tenant: DEMO.tenantId,
    ...init,
  });
const json = async <T>(response: Response) => (await response.json()) as T;

async function asOwner(sql: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Signs up and in as the mobile app does, links the member and records TOTP enrolment. */
async function member(id: string, name: string, email: string): Promise<string> {
  const signUp = await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name },
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status}`);
  const authId = ((await signUp.json()) as { user: { id: string } }).user.id;
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  const token = signIn.headers.get("set-auth-token");
  if (!token) throw new Error("no bearer token returned");
  await asOwner(
    `INSERT INTO tenant_user (id, display_name, email, status, auth_user_id)
     VALUES ($1, $2, $3, 'active', $4)`,
    [id, name, email, authId],
  );
  await h.db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [authId]);
  await markSessionsVerified(h.db.pool("harbour_auth"));
  return token;
}

async function newRisk(personId: string): Promise<string> {
  const response = await as("owner", `/v1/people/${personId}/risk-assessments`, {
    method: "POST",
    body: {
      templateKey: "moving_and_handling",
      hazard: "Transfers from bed to chair",
      whoAtRisk: "The person and the staff helping",
      answers: {
        bears_weight: false,
        cooperates: true,
        equipment_needed: true,
        equipment_examined: true,
      },
      likelihood: 3,
      severity: 4,
      residualLikelihood: 1,
      residualSeverity: 4,
      controls: ["Two staff for every transfer"],
      assessedOn: new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" }),
    },
  });
  if (response.status !== 201) throw new Error(`risk: ${response.status} ${await response.text()}`);
  return (await json<RiskAssessmentItem>(response)).id;
}

const riskHistory = (personId: string, riskId: string) =>
  `/v1/people/${personId}/care-history/risk_assessment/${riskId}`;

/** The scope of the latest history view of a resource, as the audit log keeps it. */
async function lastViewScope(action: string, resourceId: string) {
  const rows = await asOwner(
    `SELECT scope FROM audit_event WHERE action = $1 AND resource_id = $2
     ORDER BY occurred_at DESC LIMIT 1`,
    [action, resourceId],
  );
  return (rows[0] as { scope: Record<string, unknown> | null } | undefined)?.scope ?? null;
}

let houseRisk = "";
let lodgeRisk = "";

beforeAll(async () => {
  h = await createHarness();
  tokens.mia = await member(MIA, "Mia Twoplaces", "mia.twoplaces@example.invalid");
  tokens.bo = await member(BO, "Bo Brokeglass", "bo.brokeglass@example.invalid");
  await asOwner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1::uuid, id, $2::uuid FROM role WHERE key = 'team_leader'
     UNION ALL SELECT $1::uuid, id, $3::uuid FROM role WHERE key = 'registered_manager'`,
    [MIA, DEMO.locationId, LODGE.locationId],
  );
  await asOwner(
    `INSERT INTO role (id, key, name, scope_kind, permissions)
     VALUES ($1, 'break_glass_reader', 'Break-glass reader', 'location',
             '{people.person.read,care.plan.read,people.person.break_glass}')`,
    [BREAK_GLASS_ROLE],
  );
  await asOwner(
    "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
    [BO, BREAK_GLASS_ROLE, DEMO.locationId],
  );
  houseRisk = await newRisk(HOUSE_PERSON);
  lodgeRisk = await newRisk(LODGE.personId);
  const opened = await as("bo", "/v1/people/break-glass", {
    method: "POST",
    body: { personId: LODGE.personId, justification: "Covering an emergency at the lodge tonight" },
  });
  if (opened.status !== 201)
    throw new Error(`break-glass: ${opened.status} ${await opened.text()}`);
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-024 a removed record's history", () => {
  it("is there for everyone who reads the record while it is not removed", async () => {
    expect((await as("mia", riskHistory(HOUSE_PERSON, houseRisk))).status).toBe(200);
    expect((await as("bo", riskHistory(LODGE.personId, lodgeRisk))).status).toBe(200);
    expect(await lastViewScope("care.history.view", lodgeRisk)).not.toHaveProperty("removed");
  });

  it("is found only where the reader's audit permission reaches, never by break-glass", async () => {
    await asOwner("UPDATE risk_assessment SET deleted_at = now() WHERE id = ANY($1::uuid[])", [
      [houseRisk, lodgeRisk],
    ]);
    // Mia's care plan permission reaches Harbour House, her audit permission only the Lodge.
    expect((await as("mia", riskHistory(HOUSE_PERSON, houseRisk))).status).toBe(404);
    const lodge = await as("mia", riskHistory(LODGE.personId, lodgeRisk));
    expect(lodge.status).toBe(200);
    expect((await json<RecordHistory>(lodge)).latestChanged).toContain("deleted_at");
    expect(await lastViewScope("care.history.view", lodgeRisk)).toMatchObject({ removed: true });
    // Bo reads the Lodge resident by break-glass only, and holds no audit permission.
    expect((await as("bo", riskHistory(LODGE.personId, lodgeRisk))).status).toBe(404);
    // The demo Registered Manager holds the audit permission at Harbour House only: the House
    // record's history, never the Lodge's.
    expect((await as("manager", riskHistory(HOUSE_PERSON, houseRisk))).status).toBe(200);
    expect((await as("manager", riskHistory(LODGE.personId, lodgeRisk))).status).toBe(404);
  });
});

describe("hazard HZ-024 a removed person's history", () => {
  it("is found only where the reader's audit permission reaches, never by break-glass", async () => {
    const history = (personId: string) => `/v1/people/${personId}/history`;
    expect((await as("bo", history(LODGE.personId))).status).toBe(200);
    // An earlier version of each, then each removed.
    await asOwner("UPDATE person SET preferred_name = 'Example' WHERE id = ANY($1::uuid[])", [
      [HOUSE_PERSON_REMOVED, LODGE.personId],
    ]);
    await asOwner("UPDATE person SET deleted_at = now() WHERE id = ANY($1::uuid[])", [
      [HOUSE_PERSON_REMOVED, LODGE.personId],
    ]);
    expect((await as("mia", history(HOUSE_PERSON_REMOVED))).status).toBe(404);
    expect((await as("bo", history(LODGE.personId))).status).toBe(404);
    const lodge = await as("mia", history(LODGE.personId));
    expect(lodge.status).toBe(200);
    const body = await json<RecordHistory>(lodge);
    expect(body.versions.length).toBeGreaterThan(0);
    expect(body.latestChanged).toContain("deleted_at");
    expect(await lastViewScope("people.person.history_view", LODGE.personId)).toMatchObject({
      removed: true,
    });
    expect((await as("manager", history(HOUSE_PERSON_REMOVED))).status).toBe(200);
  });
});

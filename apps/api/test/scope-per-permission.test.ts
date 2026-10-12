import type { CareNoteList, Me, PersonList, SyncToken, TaskList } from "@harbour/contracts";
import { withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { sql } from "drizzle-orm";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { inScopeOf, SCOPE_WITHOUT_PERMISSION } from "../src/http/context";
import { ENTRY_PERMISSION, personReachedBy } from "../src/services/devices";
import { createHarness, type Harness, LODGE, PASSWORD } from "./support/harness";

/**
 * Data scope is per permission (ADR-0071; hazard HZ-011). Two members of staff at Harbour House
 * (the demo location) and Harbour Lodge (`LODGE`), all invented:
 * - Tia Twohomes is a team leader at Harbour House and a finance viewer across the organisation
 *   (a role the organisation designed, carrying finance.reporting.read only): the issue's example.
 * - Gil Granted is an administrator at Harbour House with an acting-up grant at Harbour Lodge
 *   carrying people.person.read, care.note.read and care.note.write.
 * - Ned Nightnurse is a team leader at Harbour House and a clinical lead (who manages incidents)
 *   at Harbour Lodge.
 * Before ADR-0071, Tia's care permissions reached every home (the widest scope of any role won)
 * and Gil's grant applied over his role's home, not the grant's.
 */

const TIA = "0194d000-0000-7000-8000-0000000003a1";
const GIL = "0194d000-0000-7000-8000-0000000003a2";
const NED = "0194d000-0000-7000-8000-0000000003a3";
const FINANCE_VIEWER_ROLE = "0194d000-0000-7000-8000-0000000005a1";
const HOUSE_PERSON = "0194d000-0000-7000-8600-000000000001";
const LODGE_PERSON = LODGE.personId;
const DAY = 86_400_000;

let h: Harness;
type Who = "tia" | "gil" | "ned";
const tokens: Record<Who, string> = { tia: "", gil: "", ned: "" };

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
  return token;
}

beforeAll(async () => {
  h = await createHarness();
  tokens.tia = await member(TIA, "Tia Twohomes", "tia.twohomes@example.invalid");
  tokens.gil = await member(GIL, "Gil Granted", "gil.granted@example.invalid");
  tokens.ned = await member(NED, "Ned Nightnurse", "ned.nightnurse@example.invalid");
  await asOwner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1::uuid, id, $2::uuid FROM role WHERE key = 'team_leader'
     UNION ALL SELECT $1::uuid, id, $3::uuid FROM role WHERE key = 'clinical_lead'`,
    [NED, DEMO.locationId, LODGE.locationId],
  );
  await asOwner(
    `INSERT INTO role (id, key, name, scope_kind, permissions)
     VALUES ($1, 'finance_viewer', 'Finance viewer', 'tenant', '{finance.reporting.read}')`,
    [FINANCE_VIEWER_ROLE],
  );
  await asOwner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $2 FROM role WHERE key = 'team_leader'`,
    [TIA, DEMO.locationId],
  );
  await asOwner("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
    TIA,
    FINANCE_VIEWER_ROLE,
  ]);
  await asOwner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $2 FROM role WHERE key = 'administrator'`,
    [GIL, DEMO.locationId],
  );
  await asOwner(
    `INSERT INTO access_grant
       (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
     VALUES ($1, '{people.person.read,care.note.read,care.note.write}', $2, $3, $4,
             'Acting up at Harbour Lodge', $5)`,
    [
      GIL,
      LODGE.locationId,
      new Date(Date.now() - DAY),
      new Date(Date.now() + DAY),
      DEMO.users.owner.id,
    ],
  );
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: Who, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: tokens[who], tenant: DEMO.tenantId, ...init });

const writeNote = (who: "tia" | "gil", personId: string) =>
  as(who, `/v1/people/${personId}/notes`, {
    method: "POST",
    body: {
      category: "personal_care",
      body: "Assisted with a wash; skin intact.",
      occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    },
  });

const readNotes = (who: "tia" | "gil", personId: string) => as(who, `/v1/people/${personId}/notes`);

describe("hazard HZ-011 data scope is per permission (ADR-0071)", () => {
  it("lets a team leader who also views finance everywhere read and write care notes at their own home", async () => {
    expect((await writeNote("tia", HOUSE_PERSON)).status).toBe(201);
    const notes = await readNotes("tia", HOUSE_PERSON);
    expect(notes.status).toBe(200);
    expect((await notes.json()) as CareNoteList).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ body: "Assisted with a wash; skin intact." }),
      ]),
    });
  });

  it("refuses that team leader the other home's care notes and people, reading and writing", async () => {
    expect((await readNotes("tia", LODGE_PERSON)).status).toBe(404);
    expect((await writeNote("tia", LODGE_PERSON)).status).toBe(404);
    expect((await as("tia", `/v1/people/${LODGE_PERSON}`)).status).toBe(404);
    const people = (await (await as("tia", "/v1/people")).json()) as PersonList;
    const ids = people.items.map((p) => p.id);
    expect(ids).toContain(HOUSE_PERSON);
    expect(ids).not.toContain(LODGE_PERSON);
  });

  it("lets a grant reach the grant's home: an administrator acting up at the other home", async () => {
    expect((await writeNote("gil", LODGE_PERSON)).status).toBe(201);
    expect((await readNotes("gil", LODGE_PERSON)).status).toBe(200);
    expect((await as("gil", `/v1/people/${LODGE_PERSON}`)).status).toBe(200);
  });

  it("refuses the grant's permissions at the role's home, where the grant does not reach", async () => {
    expect((await readNotes("gil", HOUSE_PERSON)).status).toBe(404);
    expect((await writeNote("gil", HOUSE_PERSON)).status).toBe(404);
    expect((await as("gil", `/v1/people/${HOUSE_PERSON}`)).status).toBe(404);
  });

  it("syncs only the people at the home where every synced read permission reaches", async () => {
    const claims = async (who: "tia" | "gil") => {
      const response = await as(who, "/v1/sync/token", { method: "POST" });
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as SyncToken;
      return (await jwtVerify(token, h.handle.signer.verificationKey)).payload;
    };
    expect((await claims("tia")).people_location_ids).toEqual([DEMO.locationId]);
    // The location streams carry care plans too: a grant without care.plan.read syncs no one there.
    expect((await claims("gil")).people_location_ids).toEqual([]);
    await asOwner(
      `INSERT INTO access_grant
         (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
       VALUES ($1, '{care.plan.read}', $2, $3, $4, 'Acting up at Harbour Lodge', $5)`,
      [
        GIL,
        LODGE.locationId,
        new Date(Date.now() - DAY),
        new Date(Date.now() + DAY),
        DEMO.users.owner.id,
      ],
    );
    expect((await claims("gil")).people_location_ids).toEqual([LODGE.locationId]);
  });

  it("lists and moves tasks about people only where the reader may open their record", async () => {
    const due = new Date(Date.now() + 60 * 60_000);
    const [house] = await asOwner(
      `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at)
       VALUES ($1, $2, 'platform.manual', 'Check', 'care.note.write', $3) RETURNING id`,
      [HOUSE_PERSON, DEMO.locationId, due],
    );
    const [lodge] = await asOwner(
      `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at)
       VALUES ($1, $2, 'platform.manual', 'Check', 'care.note.write', $3) RETURNING id`,
      [LODGE_PERSON, LODGE.locationId, due],
    );
    const listed = ((await (await as("tia", "/v1/tasks")).json()) as TaskList).items.map(
      (t) => t.id,
    );
    expect(listed).toContain(house?.id);
    expect(listed).not.toContain(lodge?.id);
    const start = (id: string) =>
      as("tia", `/v1/tasks/${id}/transition`, {
        method: "POST",
        body: { to: "in_progress", version: 1 },
      });
    expect((await start(lodge?.id)).status).toBe(404);
    expect((await start(house?.id)).status).toBe(200);
  });

  it("lets someone manage incidents only where they hold safety.incident.manage", async () => {
    // A near miss involving nobody at each home, raised by the owner.
    const raise = async (locationId: string) => {
      const response = await h.request("/v1/incidents", {
        token: h.tokens.owner,
        tenant: DEMO.tenantId,
        method: "POST",
        body: {
          locationId,
          type: "near_miss",
          occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
          description: "A hoist sling nearly gave way.",
          people: [],
        },
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string; version: number };
    };
    const change = (incident: { id: string; version: number }) =>
      as("ned", `/v1/incidents/${incident.id}`, {
        method: "PUT",
        body: { description: "A hoist sling nearly gave way; taken out of use.", ...incident },
      });
    const answer = (incident: { id: string }) =>
      as("ned", `/v1/incidents/${incident.id}/classifier`, {
        method: "POST",
        body: { answers: [{ key: "safeguarding.concern", value: "no" }] },
      });
    const house = await raise(DEMO.locationId);
    expect((await change(house)).status).toBe(403);
    expect((await answer(house)).status).toBe(403);
    const lodge = await raise(LODGE.locationId);
    expect((await change(lodge)).status).toBe(200);
    expect((await answer(lodge)).status).toBe(200);
  });

  it("says whose records the user may open, and keeps the permissions for the screens", async () => {
    const me = (await (await as("tia", "/v1/me")).json()) as Me;
    expect(me.scope).toBe("locations");
    expect(me.permissions).toEqual(
      expect.arrayContaining(["care.note.write", "finance.reporting.read"]),
    );
  });

  it("lets only the listed routes run in a permission's scope without requiring it", () => {
    expect(SCOPE_WITHOUT_PERMISSION).toEqual({
      "GET /v1/tasks": "people.person.read",
      "POST /v1/tasks/:id/transition": "people.person.read",
      "GET /v1/documents/:id": "people.person.read",
      "GET /v1/documents/:id/content": "people.person.read",
      "POST /v1/documents/:id/signatures": "people.person.read",
      "POST /v1/documents/:id/versions": "people.person.read",
    });
  });

  it("takes a refused copy or a hand-over only about someone the author could reach with care.note.write", async () => {
    const reached = (author: string, personId: string) =>
      withRequestContext(
        h.handle.services.db,
        { tenantId: DEMO.tenantId, userId: author, scope: "tenant", locationIds: [] },
        (tx) =>
          personReachedBy(
            tx,
            author,
            personId,
            new Date(Date.now() - DAY),
            new Date(),
            ENTRY_PERMISSION,
          ),
      );
    // The finance role reaches every home but carries no care.note.write.
    expect(await reached(TIA, HOUSE_PERSON)).toBe(true);
    expect(await reached(TIA, LODGE_PERSON)).toBe(false);
    // The grant reaches its own home; the administrator role carries no care.note.write.
    expect(await reached(GIL, LODGE_PERSON)).toBe(true);
    expect(await reached(GIL, HOUSE_PERSON)).toBe(false);
    // A revoked grant never counts.
    await asOwner("UPDATE access_grant SET revoked_at = now() WHERE tenant_user_id = $1", [GIL]);
    expect(await reached(GIL, LODGE_PERSON)).toBe(false);
  });

  it("puts back the transaction's own scope after a check in another permission's scope", async () => {
    const scopeNow = async (tx: Parameters<Parameters<typeof withRequestContext>[2]>[0]) => {
      const { rows } = await tx.execute<{ scope: string; locations: string }>(
        sql`SELECT current_setting('app.scope', true) AS scope,
                   current_setting('app.location_ids', true) AS locations`,
      );
      return rows[0];
    };
    const seen = await withRequestContext(
      h.handle.services.db,
      { tenantId: DEMO.tenantId, userId: TIA, scope: "locations", locationIds: [DEMO.locationId] },
      async (tx) => {
        const inside = await inScopeOf(tx, { scope: "tenant", locationIds: [] }, () =>
          scopeNow(tx),
        );
        const after = await scopeNow(tx);
        await expect(
          inScopeOf(tx, { scope: "tenant", locationIds: [] }, () =>
            Promise.reject(new Error("refused")),
          ),
        ).rejects.toThrow("refused");
        return { inside, after, afterRefusal: await scopeNow(tx) };
      },
    );
    expect(seen.inside).toEqual({ scope: "tenant", locations: "" });
    expect(seen.after).toEqual({ scope: "locations", locations: DEMO.locationId });
    expect(seen.afterRefusal).toEqual({ scope: "locations", locations: DEMO.locationId });
  });
});

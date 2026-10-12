import type {
  AuditList,
  CareNoteList,
  Me,
  PersonList,
  SyncToken,
  TaskList,
} from "@harbour/contracts";
import { withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { sql } from "drizzle-orm";
import { jwtVerify } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { inScopeOf, SCOPE_WITHOUT_PERMISSION } from "../src/http/context";
import { fallbackRecipients } from "../src/services/device-holds";
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

  it("syncs each family of streams only where its own read permission reaches (review round 1, C-M1)", async () => {
    const claims = async (who: "tia" | "gil") => {
      const response = await as(who, "/v1/sync/token", { method: "POST" });
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as SyncToken;
      return (await jwtVerify(token, h.handle.signer.verificationKey)).payload;
    };
    expect(await claims("tia")).toMatchObject({
      people_location_ids: [DEMO.locationId],
      care_location_ids: [DEMO.locationId],
      entries_location_ids: [DEMO.locationId],
    });
    // The grant carries the person and the notes, not the care plan: the recent entries sync at
    // the Lodge, and the phone may record there; the care reference does not, and nor does the
    // person, who syncs only with their care reference (review round 2).
    expect(await claims("gil")).toMatchObject({
      people_location_ids: [],
      care_location_ids: [],
      entries_location_ids: [LODGE.locationId],
      entries_write_location_ids: [LODGE.locationId],
      people_assigned: false,
    });
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
    expect(await claims("gil")).toMatchObject({
      people_location_ids: [LODGE.locationId],
      care_location_ids: [LODGE.locationId],
    });
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
        const inside = await inScopeOf(
          tx,
          { scope: "tenant", locationIds: [], includesAssigned: true, includesBreakGlass: true },
          () => scopeNow(tx),
        );
        const after = await scopeNow(tx);
        await expect(
          inScopeOf(
            tx,
            { scope: "tenant", locationIds: [], includesAssigned: true, includesBreakGlass: true },
            () => Promise.reject(new Error("refused")),
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

describe("hazard HZ-011 data scope per permission, review round 1 (ADR-0071)", () => {
  // More invented staff:
  // - Sam Shiftsplit is a care worker (scoped to assigned people) and a clinical lead at Harbour
  //   House, and is assigned to Gwen at Harbour Lodge.
  // - Cora Coordinator is a care coordinator at Harbour House (people.person.read and
  //   care.plan.read there, no care.note.read) with a grant of care.note.read and care.note.write
  //   at Harbour Lodge.
  // - Bea Backup is a Registered Manager at Harbour House; Lou Longserving one at Harbour Lodge,
  //   in post for longer than anyone.
  const SAM = "0194d000-0000-7000-8000-0000000003b1";
  const CORA = "0194d000-0000-7000-8000-0000000003b2";
  const BEA = "0194d000-0000-7000-8000-0000000003b3";
  const LOU = "0194d000-0000-7000-8000-0000000003b4";
  const staff: Record<"sam" | "cora" | "bea", string> = { sam: "", cora: "", bea: "" };
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  // A resident at Harbour House the demo care worker is not assigned to.
  const UNASSIGNED = "0194d000-0000-7000-8600-000000000005";

  const tokenOf = (key: string) => h.tokens[key] ?? "";
  const asStaff = (
    token: string,
    path: string,
    init: {
      method?: string;
      body?: unknown;
      raw?: { bytes: Uint8Array; contentType: string };
    } = {},
  ) => h.request(path, { token, tenant: DEMO.tenantId, ...init });

  beforeAll(async () => {
    staff.sam = await member(SAM, "Sam Shiftsplit", "sam.shiftsplit@example.invalid");
    staff.cora = await member(CORA, "Cora Coordinator", "cora.coordinator@example.invalid");
    staff.bea = await member(BEA, "Bea Backup", "bea.backup@example.invalid");
    await asOwner(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Lou Longserving', 'lou.longserving@example.invalid', 'active')`,
      [LOU],
    );
    await asOwner(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1::uuid, id, $2::uuid FROM role WHERE key IN ('care_worker', 'clinical_lead')
       UNION ALL SELECT $3::uuid, id, $2::uuid FROM role WHERE key = 'care_coordinator'
       UNION ALL SELECT $4::uuid, id, $2::uuid FROM role WHERE key = 'registered_manager'`,
      [SAM, DEMO.locationId, CORA, BEA],
    );
    await asOwner(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from)
       SELECT $1, id, $2, now() - interval '400 days' FROM role WHERE key = 'registered_manager'`,
      [LOU, LODGE.locationId],
    );
    await asOwner("INSERT INTO person_assignment (tenant_user_id, person_id) VALUES ($1, $2)", [
      SAM,
      LODGE_PERSON,
    ]);
    await asOwner(
      `INSERT INTO access_grant
         (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
       VALUES ($1, '{care.note.read,care.note.write}', $2, $3, $4, 'Covering notes', $5)`,
      [
        CORA,
        LODGE.locationId,
        new Date(Date.now() - DAY),
        new Date(Date.now() + DAY),
        DEMO.users.owner.id,
      ],
    );
  }, 180_000);

  describe("S-M1: assigned and break-glass people count only for the permissions that reach them", () => {
    it("lets the care worker role reach the assigned person, and nothing of the clinical lead role", async () => {
      // The care worker role carries people.person.read and care.note.write for assigned people.
      expect((await asStaff(staff.sam, `/v1/people/${LODGE_PERSON}`)).status).toBe(200);
      const note = await asStaff(staff.sam, `/v1/people/${LODGE_PERSON}/notes`, {
        method: "POST",
        body: {
          category: "personal_care",
          body: "Assisted with a wash; skin intact.",
          occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      });
      expect(note.status).toBe(201);
      // ReSPECT and a status change come from the clinical lead role at Harbour House only.
      const respect = await asStaff(staff.sam, `/v1/people/${LODGE_PERSON}/advance-care`, {
        method: "POST",
        body: {
          kind: "respect",
          cprDecision: "attempt_cpr",
          clinicianName: "Dr Example",
          clinicianRole: "GP",
          completedOn: new Date().toISOString().slice(0, 10),
        },
      });
      expect(respect.status).toBe(404);
      const status = await asStaff(staff.sam, `/v1/people/${LODGE_PERSON}/status`, {
        method: "POST",
        body: { to: "in_hospital", effectiveAt: new Date().toISOString(), version: 1 },
      });
      expect(status.status).toBe(404);
    });

    it("opens a break-glass person for reading only", async () => {
      expect((await asStaff(staff.bea, `/v1/people/${LODGE_PERSON}`)).status).toBe(404);
      const opened = await asStaff(staff.bea, "/v1/people/break-glass", {
        method: "POST",
        body: {
          personId: LODGE_PERSON,
          justification: "Covering an emergency at the lodge tonight",
        },
      });
      expect(opened.status).toBe(201);
      const read = await asStaff(staff.bea, `/v1/people/${LODGE_PERSON}`);
      expect(read.status).toBe(200);
      // The record says it is open for reading only, so the screens offer no forms (round 2, C2-M2).
      expect(((await read.json()) as { access?: unknown }).access).toEqual({
        recordCare: false,
        readOnlyReason: "break_glass",
      });
      const own = await asStaff(staff.bea, `/v1/people/${HOUSE_PERSON}`);
      expect(((await own.json()) as { access?: unknown }).access).toEqual({
        recordCare: true,
        readOnlyReason: null,
      });
      expect((await asStaff(staff.bea, `/v1/people/${LODGE_PERSON}/notes`)).status).toBe(200);
      const write = await asStaff(staff.bea, `/v1/people/${LODGE_PERSON}/notes`, {
        method: "POST",
        body: {
          category: "personal_care",
          body: "Not mine to write.",
          occurredAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      });
      expect(write.status).toBe(404);
      // Signing a document about the person is a write too (review round 2, S2-M1): the letter
      // opens for reading, but cannot be signed under break-glass.
      const uploaded = await h.request(
        `/v1/documents?${new URLSearchParams({
          category: "person_document",
          title: "Hospital letter",
          personId: LODGE_PERSON,
        })}`,
        {
          token: tokenOf("owner"),
          tenant: DEMO.tenantId,
          method: "POST",
          raw: { bytes: PDF, contentType: "application/pdf" },
        },
      );
      expect(uploaded.status).toBe(201);
      const letter = (await uploaded.json()) as { id: string; sha256: string };
      expect((await asStaff(staff.bea, `/v1/documents/${letter.id}`)).status).toBe(200);
      const signed = await asStaff(staff.bea, `/v1/documents/${letter.id}/signatures`, {
        method: "POST",
        body: { typedName: "Bea Backup", signerCapacity: "staff", sha256Seen: letter.sha256 },
      });
      expect(signed.status).toBe(404);
    });
  });

  describe("S-M2, L4 and L5: documents are read with their category's permission", () => {
    let attachment = "";
    let letter = "";

    beforeAll(async () => {
      const upload = async (category: string, title: string, bytes: Uint8Array, type: string) => {
        const response = await h.request(
          `/v1/documents?${new URLSearchParams({ category, title, personId: HOUSE_PERSON })}`,
          {
            token: tokenOf("manager"),
            tenant: DEMO.tenantId,
            method: "POST",
            raw: { bytes, contentType: type },
          },
        );
        expect(response.status).toBe(201);
        return ((await response.json()) as { id: string }).id;
      };
      attachment = await upload("care_attachment", "Wound photo", JPEG, "image/jpeg");
      letter = await upload("person_document", "Hospital letter", PDF, "application/pdf");
    });

    it("shows a care attachment only where care.note.read reaches the person", async () => {
      // Cora reads people at Harbour House, but care notes only at Harbour Lodge.
      expect((await asStaff(staff.cora, `/v1/documents/${letter}`)).status).toBe(200);
      expect((await asStaff(staff.cora, `/v1/documents/${attachment}`)).status).toBe(404);
      expect((await asStaff(staff.cora, `/v1/documents/${attachment}/content`)).status).toBe(404);
      const list = await asStaff(staff.cora, `/v1/documents?personId=${HOUSE_PERSON}`);
      expect(list.status).toBe(200);
      const ids = ((await list.json()) as { items: { id: string }[] }).items.map((d) => d.id);
      expect(ids).toContain(letter);
      expect(ids).not.toContain(attachment);
      // The manager, whose care.note.read reaches Harbour House, sees both.
      const managers = await asStaff(tokenOf("manager"), `/v1/documents?personId=${HOUSE_PERSON}`);
      const all = ((await managers.json()) as { items: { id: string }[] }).items.map((d) => d.id);
      expect(all).toEqual(expect.arrayContaining([letter, attachment]));
    });

    it("refuses a new version where the upload permission does not reach, storing nothing", async () => {
      const response = await asStaff(staff.cora, `/v1/documents/${attachment}/versions`, {
        method: "POST",
        raw: { bytes: JPEG, contentType: "image/jpeg" },
      });
      expect(response.status).toBe(404);
      const versions = await asOwner(
        "SELECT count(*)::int AS n FROM document WHERE previous_version_id = $1",
        [attachment],
      );
      expect(versions[0]?.n).toBe(0);
    });

    it("answers HEAD on an allow-listed route as its GET route (L5)", async () => {
      const head = await asStaff(staff.cora, `/v1/documents/${letter}/content`, { method: "HEAD" });
      expect(head.status).toBe(200);
    });

    it("never attaches an organisation's document to a person's record (review round 2)", async () => {
      const response = await h.request(
        `/v1/documents?${new URLSearchParams({
          category: "organisation_document",
          title: "Policy about a resident",
          subjectType: "person",
          subjectId: HOUSE_PERSON,
        })}`,
        {
          token: tokenOf("manager"),
          tenant: DEMO.tenantId,
          method: "POST",
          raw: { bytes: PDF, contentType: "application/pdf" },
        },
      );
      expect(response.status).toBe(422);
    });
  });

  describe("S-M3: the audit trail follows the reach of platform.audit.read", () => {
    it("shows a manager at one home their own events and events about people there, never a reason", async () => {
      // Ned views Gwen at the Lodge; Tia views a resident at the House.
      expect((await as("ned", `/v1/people/${LODGE_PERSON}`)).status).toBe(200);
      expect((await as("tia", `/v1/people/${HOUSE_PERSON}`)).status).toBe(200);
      const trail = async (token: string, personId: string) => {
        const response = await asStaff(
          token,
          `/v1/audit?resourceType=person&resourceId=${personId}&limit=500`,
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as AuditList).items;
      };
      const views = (items: AuditList["items"], actor: string) =>
        items.filter((e) => e.action === "people.person.view" && e.actorTenantUserId === actor);
      // The Registered Manager at the House: the House resident, not Gwen.
      expect(views(await trail(tokenOf("manager"), HOUSE_PERSON), TIA).length).toBeGreaterThan(0);
      expect(views(await trail(tokenOf("manager"), LODGE_PERSON), NED)).toEqual([]);
      for (const event of await trail(tokenOf("manager"), HOUSE_PERSON)) {
        expect(event.reason).toBeNull();
      }
      // The quality lead holds it across the organisation and sees both.
      expect(views(await trail(tokenOf("quality"), LODGE_PERSON), NED).length).toBeGreaterThan(0);
    });
  });

  describe("C-M4: a task about a person goes only to someone who can see the person", () => {
    const createTask = (personId: string, assignee: string) =>
      asStaff(tokenOf("manager"), "/v1/tasks", {
        method: "POST",
        body: {
          title: "Check skin on heels",
          personId,
          locationId: DEMO.locationId,
          assigneeTenantUserId: assignee,
          dueAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        },
      });

    it("refuses to give a task about a person to a care worker not assigned to them", async () => {
      expect((await createTask(UNASSIGNED, DEMO.users.carer.id)).status).toBe(422);
      expect((await createTask(HOUSE_PERSON, DEMO.users.carer.id)).status).toBe(201);
    });

    it("skips a Registered Manager at another home in the fallback for a task about a person", async () => {
      const [anyone, forHouse] = await withRequestContext(
        h.handle.services.db,
        { tenantId: DEMO.tenantId, userId: null, scope: "tenant", locationIds: [] },
        async (tx) => [
          await fallbackRecipients(tx, "care.plan.write", new Date()),
          await fallbackRecipients(tx, "care.plan.write", new Date(), HOUSE_PERSON),
        ],
      );
      // Longest serving: Lou at the Lodge, for a task about no one.
      expect(anyone?.[0]).toBe(LOU);
      // About someone at the House: Lou cannot open the record, so a manager there is chosen.
      expect(forHouse).not.toContain(LOU);
      expect(forHouse?.[0]).toBe(DEMO.users.manager.id);
    });
  });
});

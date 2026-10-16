import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import {
  createHarness,
  type Harness,
  LODGE,
  markSessionsVerified,
  OTHER,
  PASSWORD,
} from "./support/harness";

/**
 * Publishing family updates from records through the API (comms.md rules 6 to 12; COMMS-001
 * part 1b; hazards HZ-022, HZ-060, HZ-061): a note shared in words written for the family, an
 * activity in approved phrasing, a photo only with the person's consent to photos, a retry that
 * publishes once, refusals audited with codes only, and the feed still closed to a family member
 * without a sharing decision.
 */

let h: Harness;
const ADA = "0194d000-0000-7000-8600-000000000001";
const FAMILY = "0194d000-0000-7000-8000-0000000003f1";
let noteId = "";
let activityId = "";
let photoId = "";
let benActivityId = "";
let lodgeActivityId = "";
let familyToken = "";
const BEN = "0194d000-0000-7000-8600-000000000002";

const insertDocument = (category: string, title: string) =>
  sql<{ id: string }>(
    `INSERT INTO document (category, title, retention_class, storage_key, content_type,
       size_bytes, sha256, person_id)
     VALUES ($1, $2, 'care_record', 'fixture/photo', 'image/jpeg', 10, repeat('0', 64), $3)
     RETURNING id`,
    [category, title, ADA],
  ).then((rows) => rows[0]?.id as string);

const insertActivity = (personId: string, locationId: string) =>
  sql<{ id: string }>(
    `INSERT INTO activity_record (person_id, location_id, occurred_at, activity, format, attendance, engagement)
     VALUES ($1, $2, now() - interval '1 hour', 'Garden club', 'one_to_one', 'attended', 'engaged_throughout')
     RETURNING id`,
    [personId, locationId],
  ).then((rows) => rows[0]?.id as string);

const as = (who: string, path: string, body: unknown, tenant: string = DEMO.tenantId) =>
  h.request(path, { method: "POST", body, token: h.tokens[who], tenant });
const publishFor = (who: string, source: unknown, extra: object = {}, person = ADA) =>
  as(who, `/v1/people/${person}/feed`, { id: randomUUID(), source, ...extra });

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  family = false,
) {
  const client = await h.db.pool(family ? "harbour_app" : "harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', $2, true),
              set_config('app.user_id', $3, true), set_config('app.family', $4, true)`,
      [
        DEMO.tenantId,
        family ? "none" : "tenant",
        family ? FAMILY : DEMO.users.manager.id,
        family ? "true" : "",
      ],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  h = await createHarness();
  const [loc] = await sql<{ id: string }>("SELECT location_id AS id FROM person WHERE id = $1", [
    ADA,
  ]);
  noteId = (
    await sql<{ id: string }>(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body)
       VALUES ($1, $2, now() - interval '2 hours', 'activity', 'Clinical wording for staff') RETURNING id`,
      [ADA, loc?.id],
    )
  )[0]?.id as string;
  activityId = (
    await sql<{ id: string }>(
      `INSERT INTO activity_record (person_id, location_id, occurred_at, activity, format, attendance, engagement)
       VALUES ($1, $2, now() - interval '1 hour', 'Garden club', 'one_to_one', 'attended', 'engaged_throughout')
       RETURNING id`,
      [ADA, loc?.id],
    )
  )[0]?.id as string;
  photoId = await insertDocument("feed_photo", "Photo");
  benActivityId = await insertActivity(BEN, loc?.id as string);
  lodgeActivityId = await insertActivity(LODGE.personId, LODGE.locationId);
  // A family member linked to Ada's contact, with no sharing decision.
  const email = "fay.publish@example.invalid";
  await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name: "Fay Family" },
  });
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  familyToken = signIn.headers.get("set-auth-token") as string;
  const [user] = await h.db
    .pool("harbour_auth")
    .query<{ id: string }>(
      "UPDATE auth.user SET two_factor_enabled = true, email_verified = true WHERE email = $1 RETURNING id",
      [email],
    )
    .then((result) => result.rows);
  await markSessionsVerified(h.db.pool("harbour_auth"));
  await sql(
    `INSERT INTO tenant_user (id, display_name, email, status, auth_user_id)
     VALUES ($1, 'Fay Family', $2, 'active', $3)`,
    [FAMILY, email, user?.id],
  );
  await sql(
    "INSERT INTO role_assignment (tenant_user_id, role_id) SELECT $1, id FROM role WHERE key = 'family_representative'",
    [FAMILY],
  );
  await sql(
    `INSERT INTO family_portal_user (tenant_user_id, person_id, contact_id)
     SELECT $1, $2, id FROM contact WHERE person_id = $2 LIMIT 1`,
    [FAMILY, ADA],
  );
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-022 publishing family updates", () => {
  it("shares a note in the words written for the family, once however often it is sent", async () => {
    const id = randomUUID();
    const body = {
      id,
      source: { kind: "shared_note", noteId, text: "Addie planted bulbs in the garden today." },
    };
    const first = await as("manager", `/v1/people/${ADA}/feed`, body);
    expect(first.status).toBe(201);
    const made = (await first.json()) as { item: { id: string; text: string; section: string } };
    expect(made.item).toMatchObject({ id, section: "daily_updates" });
    expect(made.item.text).not.toContain("Clinical");
    const again = await as("manager", `/v1/people/${ADA}/feed`, body);
    expect(again.status).toBe(200);
    expect((await sql("SELECT id FROM feed_item WHERE source_id = $1", [noteId])).length).toBe(1);
    const [event] = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'comms.feed.item_published' AND resource_id = $1",
      [id],
    );
    expect(JSON.stringify(event?.scope)).not.toContain("bulbs");
  });

  it("writes an activity in approved phrasing", async () => {
    const response = await publishFor("manager", { kind: "activity", activityId });
    expect(response.status).toBe(201);
    const { item } = (await response.json()) as { item: { text: string; kind: string } };
    expect(item.kind).toBe("activity");
    expect(item.text).toContain("Garden club");
  });

  it("refuses another resident's name and audits the code, never the words", async () => {
    const response = await publishFor("manager", {
      kind: "shared_note",
      noteId,
      text: "Addie sat with Ben Sample at lunch.",
    });
    expect(response.status).toBe(422);
    const [event] = await sql<{ reason: string; scope: unknown }>(
      "SELECT reason, scope FROM audit_event WHERE action = 'comms.feed.publish_refused' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(event?.reason).toContain("names_another_resident");
    expect(JSON.stringify(event)).not.toContain("Sample");
  });

  it("publishes a photo only with the person's consent to photos (optional processing)", async () => {
    const photo = { kind: "photo", documentId: photoId, caption: null, onlyThisPerson: true };
    const refused = await publishFor("manager", photo);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { detail: string }).detail).toContain("photos");
    expect((await publishFor("manager", { ...photo, onlyThisPerson: false })).status).toBe(422);
    await sql(
      `INSERT INTO consent_record (person_id, decision, outcome, given_by_kind, capacity_status, given_at, evidence)
       VALUES ($1, 'photos', 'given', 'person', 'assumed', now(), 'Asked in person')`,
      [ADA],
    );
    const published = await publishFor("manager", photo);
    expect(published.status).toBe(201);
    expect(((await published.json()) as { item: { kind: string } }).item.kind).toBe("photo");
  });

  it("hazard HZ-022 leaves the feed closed to a family member without a sharing decision", async () => {
    expect((await sql("SELECT id FROM feed_item WHERE person_id = $1", [ADA])).length).toBe(3);
    expect(await sql("SELECT id FROM feed_item", [], true)).toEqual([]);
  });

  it("denies those without the permission, out of scope and in another organisation", async () => {
    expect((await publishFor("carer", { kind: "activity", activityId })).status).toBe(403);
    expect(
      (await publishFor("manager", { kind: "activity", activityId }, {}, LODGE.personId)).status,
    ).toBe(404);
    // Out of scope: the person is not found, before any source is looked at (nothing audited).
    const refusals = async () =>
      (await sql("SELECT id FROM audit_event WHERE action = 'comms.feed.publish_refused'")).length;
    const before = await refusals();
    expect(
      (
        await publishFor(
          "manager",
          { kind: "activity", activityId: lodgeActivityId },
          {},
          LODGE.personId,
        )
      ).status,
    ).toBe(404);
    expect(await refusals()).toBe(before);
    // Another resident's real record cannot be the source of Ada's update (audited).
    expect(
      (await publishFor("manager", { kind: "activity", activityId: benActivityId })).status,
    ).toBe(404);
    const [event] = await sql<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE action = 'comms.feed.publish_refused' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(event?.reason).toBe("source_not_found");
    const elsewhere = await as(
      "rae",
      `/v1/people/${ADA}/feed`,
      { id: randomUUID(), source: { kind: "activity", activityId } },
      OTHER.tenantId,
    );
    expect([403, 404]).toContain(elsewhere.status);
  });
});

describe("hazard HZ-022 only photos chosen for the feed", () => {
  it.each([
    ["person_photo", "an identification photo"],
    ["care_attachment", "a wound photo or other care attachment"],
    ["person_document", "a document about the person"],
  ])("hazard HZ-022 refuses %s (%s), audited", async (category) => {
    const documentId = await insertDocument(category, "Not for the feed");
    const response = await publishFor("manager", {
      kind: "photo",
      documentId,
      caption: null,
      onlyThisPerson: true,
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toContain(
      "Only a photo added for the family feed",
    );
    const [event] = await sql<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE action = 'comms.feed.publish_refused' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(event?.reason).toBe("photo_not_for_feed");
  });

  it("refuses an id reused for another record, and a record since corrected", async () => {
    const id = randomUUID();
    expect(
      (
        await as("manager", `/v1/people/${ADA}/feed`, {
          id,
          source: { kind: "activity", activityId },
        })
      ).status,
    ).toBe(201);
    const reused = await as("manager", `/v1/people/${ADA}/feed`, {
      id,
      source: { kind: "shared_note", noteId, text: "Addie enjoyed the music." },
    });
    expect(reused.status).toBe(409);
    const [loc] = await sql<{ id: string }>("SELECT location_id AS id FROM person WHERE id = $1", [
      ADA,
    ]);
    await sql(
      `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, supersedes_id, correction_reason)
       VALUES ($1, $2, now() - interval '2 hours', 'activity', 'Corrected wording', $3, 'Wrong time')`,
      [ADA, loc?.id, noteId],
    );
    const corrected = await publishFor("manager", {
      kind: "shared_note",
      noteId,
      text: "Addie enjoyed the music.",
    });
    expect(corrected.status).toBe(422);
    expect(((await corrected.json()) as { detail: string }).detail).toContain("corrected");
  });

  it("takes a photo off the family feed when the consent to photos is withdrawn", async () => {
    const [contact] = await sql<{ id: string }>(
      "SELECT id FROM contact WHERE person_id = $1 LIMIT 1",
      [ADA],
    );
    await sql(
      `INSERT INTO sharing_decision (person_id, recipient_kind, recipient_contact_id, sections, basis,
         consent_given_by, capacity, valid_from, valid_to)
       VALUES ($1, 'family', $2, '{photos,activities_and_visits}', 'consent', 'person', 'presumed',
         now() - interval '30 days', now() + interval '30 days')`,
      [ADA, contact?.id],
    );
    const feed = async () => {
      const response = await h.request("/v1/family/feed", {
        token: familyToken,
        tenant: DEMO.tenantId,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { items: { entries: { kind: string }[] }[] };
      return body.items[0]?.entries.map((e) => e.kind) ?? [];
    };
    expect(await feed()).toContain("photo");
    await sql(
      "UPDATE consent_record SET withdrawn_at = now(), withdrawn_reason = 'Changed their mind' WHERE person_id = $1 AND decision = 'photos'",
      [ADA],
    );
    const after = await feed();
    expect(after).not.toContain("photo");
    expect(after).toContain("activity");
  });
});

describe("hazard HZ-061 publishing waits while the family must hear from a person first", () => {
  const publishActivity = () => publishFor("manager", { kind: "activity", activityId });
  const held = async () => {
    const response = await publishActivity();
    if (response.status === 201) return false;
    expect(response.status).toBe(422);
    expect(((await response.json()) as { detail: string }).detail).toContain("on hold");
    return true;
  };

  it("holds for an open incident until the family is recorded as told, never for a closed one", async () => {
    const [closed] = await sql<{ id: string }>(
      `INSERT INTO incident (location_id, type, occurred_at, description, raised_by, person_ids,
         status, closed_at, closed_by, closed_reason)
       VALUES ($1, 'fall', now() - interval '3 days', 'Slipped in the lounge.', $2, $3,
         'closed', now(), $4, 'Reviewed') RETURNING id`,
      [DEMO.locationId, DEMO.users.carer.id, [ADA], DEMO.users.manager.id],
    );
    expect(closed?.id).toBeTruthy();
    expect(await held()).toBe(false);
    const [open] = await sql<{ id: string }>(
      `INSERT INTO incident (location_id, type, occurred_at, description, raised_by, person_ids)
       VALUES ($1, 'fall', now() - interval '1 hour', 'Found on the floor.', $2, $3) RETURNING id`,
      [DEMO.locationId, DEMO.users.carer.id, [ADA]],
    );
    expect(await held()).toBe(true);
    await sql(
      "UPDATE incident SET family_informed_at = now(), family_informed_who = 'Daughter, by phone' WHERE id = $1",
      [open?.id],
    );
    expect(await held()).toBe(false);
  });

  it("holds while a duty of candour step is open", async () => {
    const [incident] = await sql<{ id: string }>(
      `INSERT INTO incident (location_id, type, occurred_at, description, raised_by, person_ids,
         family_informed_at, family_informed_who)
       VALUES ($1, 'fall', now() - interval '2 hours', 'Found on the floor.', $2, $3, now(), 'Son')
       RETURNING id`,
      [DEMO.locationId, DEMO.users.carer.id, [ADA]],
    );
    await sql("INSERT INTO candour_record (incident_id, person_id) VALUES ($1, $2)", [
      incident?.id,
      ADA,
    ]);
    expect(await held()).toBe(true);
    await sql("UPDATE candour_record SET state = 'not_notifiable' WHERE incident_id = $1", [
      incident?.id,
    ]);
    expect(await held()).toBe(false);
  });

  it("holds while the person is in hospital", async () => {
    await sql("UPDATE person SET status = 'in_hospital' WHERE id = $1", [ADA]);
    expect(await held()).toBe(true);
    await sql("UPDATE person SET status = 'active' WHERE id = $1", [ADA]);
    expect(await held()).toBe(false);
  });
});

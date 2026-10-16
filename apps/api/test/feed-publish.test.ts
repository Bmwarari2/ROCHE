import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

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
  photoId = (
    await sql<{ id: string }>(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type,
         size_bytes, sha256, person_id)
       VALUES ('person_document', 'Photo', 'care_record', 'fixture/photo', 'image/jpeg', 10,
         repeat('0', 64), $1) RETURNING id`,
      [ADA],
    )
  )[0]?.id as string;
  // A family member linked to Ada's contact, with no sharing decision.
  await sql(
    `INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Fay Family', 'fay@example.invalid', 'active')`,
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
    // Another person's record cannot be used as the source.
    expect(
      (await publishFor("manager", { kind: "activity", activityId: randomUUID() })).status,
    ).toBe(404);
    const elsewhere = await as(
      "rae",
      `/v1/people/${ADA}/feed`,
      { id: randomUUID(), source: { kind: "activity", activityId } },
      OTHER.tenantId,
    );
    expect([403, 404]).toContain(elsewhere.status);
  });
});

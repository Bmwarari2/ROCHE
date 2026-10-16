import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Letters and emails through the API (comms.md rules 24 and 25; COMMS-007; ADR-0051; hazard
 * HZ-051): previewing stores nothing, values come from the record except the typed admission and
 * fee details, a recipient is the person or one of their own contacts, an incident letter needs
 * safety.incident.manage and an incident about the person, an email carries no health details, a
 * letter becomes a PDF document about the person, and the letter row keeps field keys only.
 */

let h: Harness;
let personId: string;
let contactId: string;
let otherContactId: string;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
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

/** A template made by the manager and approved by the owner; its id. */
async function approvedTemplate(body: Record<string, unknown>): Promise<string> {
  const made = (await (
    await as("manager", "/v1/letter-templates", { method: "POST", body })
  ).json()) as { id: string; draft: { id: string; version: number; issues: unknown[] } };
  expect(made.draft.issues).toEqual([]);
  const approved = await as(
    "owner",
    `/v1/letter-templates/${made.id}/versions/${made.draft.id}/approve`,
    { method: "POST", body: { version: made.draft.version } },
  );
  expect(approved.status).toBe(200);
  return made.id;
}

let admission: string;
let email: string;
let incidentLetter: string;
const url = () => `/v1/people/${personId}/letters`;

beforeAll(async () => {
  h = await createHarness();
  const [p] = await sql<{ id: string }>(
    "SELECT id FROM person WHERE location_id = $1 AND status = 'active' ORDER BY id LIMIT 1",
    [DEMO.locationId],
  );
  personId = p?.id as string;
  const [c] = await sql<{ id: string }>(
    `INSERT INTO contact (person_id, role, given_name, family_name, email, address_line1, town, postcode)
     VALUES ($1, 'next_of_kin', 'Eve', 'Example', 'eve.example@example.invalid', '1 Example Road', 'Exampletown', 'EX1 1EX')
     RETURNING id`,
    [personId],
  );
  contactId = c?.id as string;
  const [o] = await sql<{ id: string }>(
    `INSERT INTO contact (person_id, role, given_name, family_name)
     VALUES ($1, 'next_of_kin', 'Finn', 'Elsewhere') RETURNING id`,
    [LODGE.personId],
  );
  otherContactId = o?.id as string;
  admission = await approvedTemplate({
    kind: "admission",
    channel: "letter",
    name: "Welcome letter",
    subject: null,
    body: "Dear {{recipient.full_name}},\n\n{{person.preferred_name}} joins {{location.name}} on {{admission.date}}.\n\n{{sender.name}}",
  });
  email = await approvedTemplate({
    kind: "general",
    channel: "email",
    name: "Visiting news",
    subject: "News from {{location.name}}",
    body: "Dear {{recipient.full_name}},\n\nVisiting hours change next week at {{location.name}}.",
  });
  incidentLetter = await approvedTemplate({
    kind: "incident_follow_up",
    channel: "letter",
    name: "Incident follow-up",
    subject: null,
    body: "Dear {{recipient.full_name}},\n\nOn {{incident.date}}: {{incident.summary}}",
  });
});
afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-051 letters from approved templates", () => {
  const letterBody = (extra: Record<string, unknown> = {}) => ({
    templateId: admission,
    recipient: { kind: "contact", contactId },
    values: { "admission.date": "2026-11-02" },
    ...extra,
  });

  it("needs comms.letter.manage to preview, send or list", async () => {
    expect(
      (await as("carer", `${url()}/preview`, { method: "POST", body: letterBody() })).status,
    ).toBe(403);
    expect((await as("carer", url())).status).toBe(403);
  });

  it("previews with the record's values and the typed admission date, storing nothing", async () => {
    const response = await as("manager", `${url()}/preview`, {
      method: "POST",
      body: letterBody(),
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as {
      text: string;
      recipientName: string;
      personalDataFields: string[];
    };
    expect(preview.text).toContain("Dear Eve Example,");
    expect(preview.text).toContain("on 02/11/2026");
    expect(preview.recipientName).toBe("Eve Example");
    expect(preview.personalDataFields).toEqual(
      ["admission.date", "person.preferred_name", "recipient.full_name", "sender.name"].sort(),
    );
    expect(await sql("SELECT 1 FROM letter WHERE person_id = $1", [personId])).toEqual([]);
  });

  it("refuses a typed value for a field that comes from the record, a missing one, and another person's contact", async () => {
    const typed = await as("manager", `${url()}/preview`, {
      method: "POST",
      body: letterBody({
        values: { "admission.date": "2026-11-02", "person.full_name": "Someone Else" },
      }),
    });
    expect(typed.status).toBe(422);
    const missing = await as("manager", `${url()}/preview`, {
      method: "POST",
      body: letterBody({ values: {} }),
    });
    expect(missing.status).toBe(422);
    const wrong = await as("manager", `${url()}/preview`, {
      method: "POST",
      body: letterBody({ recipient: { kind: "contact", contactId: otherContactId } }),
    });
    expect(wrong.status).toBe(404);
  });

  it("sends a letter as a PDF document about the person, keeping field keys only, audited and announced", async () => {
    const response = await as("manager", url(), {
      method: "POST",
      body: { ...letterBody(), confirmed: true },
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const [row] = await sql<{
      channel: string;
      document_id: string | null;
      personal_fields: string[];
      retention_class: string;
      content_type: string;
      doc_person: string;
    }>(
      `SELECT l.channel, l.document_id, l.personal_fields, l.retention_class,
              d.content_type, d.person_id AS doc_person
         FROM letter l JOIN document d ON d.id = l.document_id WHERE l.id = $1`,
      [id],
    );
    expect(row).toMatchObject({
      channel: "letter",
      retention_class: "care_record",
      content_type: "application/pdf",
      doc_person: personId,
    });
    expect(row?.personal_fields).toContain("recipient.full_name");
    const audits = await sql<{ scope: string }>(
      "SELECT scope::text FROM audit_event WHERE resource_id = $1 AND action = 'comms.letter.sent'",
      [id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.scope).not.toContain("Eve");
    const events = await sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1",
      [id],
    );
    expect(events.map((e) => e.event_type)).toEqual(["comms.letter.sent"]);
  });

  it("sends an email to the contact's address with the body, keeping only the provider's id", async () => {
    const response = await as("manager", url(), {
      method: "POST",
      body: { templateId: email, recipient: { kind: "contact", contactId }, confirmed: true },
    });
    expect(response.status).toBe(201);
    const mail = h.handle.services.mockEmail.sent.at(-1);
    expect(mail).toMatchObject({ to: "eve.example@example.invalid", link: null });
    expect(mail?.body).toContain("Dear Eve Example,");
    const { id } = (await response.json()) as { id: string };
    const [row] = await sql<{ delivery_reference: string; document_id: string | null }>(
      "SELECT delivery_reference, document_id FROM letter WHERE id = $1",
      [id],
    );
    expect(row?.delivery_reference).toMatch(/^mock-[0-9a-f]{16}$/);
    expect(row?.document_id).toBeNull();
    const toPerson = await as("manager", url(), {
      method: "POST",
      body: { templateId: email, recipient: { kind: "person" }, confirmed: true },
    });
    expect(toPerson.status).toBe(422);
  });

  it("makes an incident letter only about an incident of this person", async () => {
    const incidentFor = async (who: string) =>
      (
        await sql<{ id: string }>(
          `INSERT INTO incident (location_id, type, occurred_at, description, raised_by, person_ids)
           VALUES ($1, 'fall', '2026-10-01T09:00:00Z', 'Found on the floor of the lounge.', $2, $3) RETURNING id`,
          [DEMO.locationId, DEMO.users.carer.id, [who]],
        )
      )[0]?.id as string;
    const mine = await incidentFor(personId);
    const body = { templateId: incidentLetter, recipient: { kind: "contact", contactId } };
    expect((await as("manager", `${url()}/preview`, { method: "POST", body })).status).toBe(422);
    const preview = await as("manager", `${url()}/preview`, {
      method: "POST",
      body: { ...body, incidentId: mine },
    });
    expect(preview.status).toBe(200);
    expect(((await preview.json()) as { text: string }).text).toContain(
      "On 01/10/2026: Found on the floor",
    );
    const [other] = await sql<{ id: string }>(
      "SELECT id FROM person WHERE location_id = $1 AND id <> $2 AND status = 'active' LIMIT 1",
      [DEMO.locationId, personId],
    );
    const theirs = await incidentFor(other?.id as string);
    const wrong = await as("manager", `${url()}/preview`, {
      method: "POST",
      body: { ...body, incidentId: theirs },
    });
    expect(wrong.status).toBe(422);
  });

  it("lists what was sent, never the content", async () => {
    const response = await as("manager", url());
    expect(response.status).toBe(200);
    const { items } = (await response.json()) as { items: Record<string, unknown>[] };
    expect(items.length).toBe(2);
    expect(JSON.stringify(items)).not.toContain("Dear Eve");
  });
});

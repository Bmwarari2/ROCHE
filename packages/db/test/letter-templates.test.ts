import { LETTER_ONLY_KINDS, TEMPLATE_KINDS, TEMPLATE_WORKFLOW } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LETTER_ONLY_KIND_CODES,
  TEMPLATE_KIND_CODES,
  TEMPLATE_VERSION_STATES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Letter and email templates and letters in the database (comms.md rules 18 to 25; ADR-0051;
 * hazards HZ-011 and HZ-051; migration 0059): cross-tenant denial, templates only for holders of
 * the template or letter permissions, versions that move along TEMPLATE_WORKFLOW and are fixed once
 * approved, approval never by the author or an editor, and append-only letters made only from an
 * approved version, in the person's scope, to them or one of their own contacts.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asWriter = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

/** A care worker with no template or letter permission. */
const CARE_ONLY = "0199e000-0000-7000-8000-0000000000d1";
const CONTACT_ADA = "0199e000-0000-7000-8000-0000000000c1";
const CONTACT_CARA = "0199e000-0000-7000-8000-0000000000c2";

const newTemplate = async (
  c: pg.PoolClient,
  kind = "general",
  channel = "letter",
): Promise<string> =>
  (
    await c.query<{ id: string }>(
      "INSERT INTO letter_template (kind, channel) VALUES ($1, $2) RETURNING id",
      [kind, channel],
    )
  ).rows[0]?.id as string;

const draft = async (
  c: pg.PoolClient,
  template: string,
  body = "Dear {{recipient.name}}, welcome.",
  subject: string | null = null,
): Promise<string> =>
  (
    await c.query<{ id: string }>(
      `INSERT INTO letter_template_version (template_id, name, subject, body)
       VALUES ($1, 'Welcome letter', $2, $3) RETURNING id`,
      [template, subject, body],
    )
  ).rows[0]?.id as string;

const approve = (c: pg.PoolClient, version: string) =>
  c.query(
    "UPDATE letter_template_version SET state = 'approved', approved_by = app.current_user_id(), approved_at = now() WHERE id = $1",
    [version],
  );

const send = (
  c: pg.PoolClient,
  values: { version: string; person: string; contact?: string | null; channel?: string },
) =>
  c.query(
    `INSERT INTO letter (template_version_id, person_id, recipient_kind, contact_id, channel,
       personal_fields, special_category, retention_class)
     VALUES ($1, $2, $3, $4, $5, '{person.name}', false, 'care_record') RETURNING id`,
    [
      values.version,
      values.person,
      values.contact ? "contact" : "person",
      values.contact ?? null,
      values.channel ?? "letter",
    ],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const all =
    "{comms.template.write,comms.template.approve,comms.letter.manage,people.person.read}";
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199e000-0000-7000-8000-000000000501', 'owner', 'Owner', 'tenant', $1),
         ('0199e000-0000-7000-8000-000000000502', 'deputy_manager', 'Deputy', 'location', $1),
         ('0199e000-0000-7000-8000-000000000503', 'administrator', 'Administrator', 'location',
          '{comms.template.write}')`,
      [all],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199e000-0000-7000-8000-000000000501', NULL),
         ($2, '0199e000-0000-7000-8000-000000000502', $3),
         ($4, '0199e000-0000-7000-8000-000000000503', $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer],
    );
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Cal Care', 'cal.care@example.invalid', 'active')`,
      [CARE_ONLY],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [CARE_ONLY, a.roleCarer, a.locationNorth],
    );
    await c.query(
      `INSERT INTO contact (id, person_id, role, given_name, family_name) VALUES
         ($1, $2, 'next_of_kin', 'Eve', 'Example'), ($3, $4, 'next_of_kin', 'Finn', 'Example')`,
      [CONTACT_ADA, a.personAda, CONTACT_CARA, a.personCara],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199e000-0000-7000-8000-000000000504', 'owner', 'Owner', 'tenant', $1)`,
      [all],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199e000-0000-7000-8000-000000000504')`,
      [b.manager],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("letter template codes match the domain", () => {
  it("keeps the kinds, letter-only kinds and states in step", () => {
    expect([...TEMPLATE_KIND_CODES]).toEqual([...TEMPLATE_KINDS]);
    expect([...LETTER_ONLY_KIND_CODES]).toEqual([...LETTER_ONLY_KINDS]);
    expect([...TEMPLATE_VERSION_STATES]).toEqual([...TEMPLATE_WORKFLOW.states]);
  });
});

describe("hazard HZ-011 letter template isolation", () => {
  it("never shows another organisation's templates, versions or letters", async () => {
    const template = await asManager((c) => newTemplate(c));
    await asOtherTenant(async (c) => {
      for (const table of ["letter_template", "letter_template_version", "letter"]) {
        const { rows } = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        expect(rows[0]?.n).toBe(0);
      }
      await expect(
        c.query(
          "INSERT INTO letter_template (tenant_id, kind, channel) VALUES ($1, 'general', 'letter')",
          [TENANT_A],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(draft(c, template)).rejects.toThrow();
    });
  });

  it("shows templates only to holders of the template or letter permissions", async () => {
    await asManager((c) => newTemplate(c));
    const careOnly = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      inContext(app(), ctx(TENANT_A, CARE_ONLY, "locations", [a.locationNorth]), fn);
    const seen = await careOnly(
      async (c) =>
        (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM letter_template")).rows[0]?.n,
    );
    expect(seen).toBe(0);
    await expect(careOnly((c) => newTemplate(c))).rejects.toThrow(/row-level security/);
    const byWriter = await asWriter(
      async (c) =>
        (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM letter_template")).rows[0]?.n,
    );
    expect(byWriter).toBeGreaterThan(0);
  });
});

describe("hazard HZ-051 template versions in the database", () => {
  it("refuses an email template for a letter-only kind, and a subject that does not fit the channel", async () => {
    await expect(asManager((c) => newTemplate(c, "duty_of_candour", "email"))).rejects.toThrow(
      /letter_only/,
    );
    const email = await asManager((c) => newTemplate(c, "general", "email"));
    await expect(asManager((c) => draft(c, email))).rejects.toThrow(/has a subject/);
    const letterTemplate = await asManager((c) => newTemplate(c));
    await expect(
      asManager((c) => draft(c, letterTemplate, "Body text", "A subject")),
    ).rejects.toThrow(/has none/);
    await expect(
      asManager((c) => draft(c, email, "Body text", "Your fees")),
    ).resolves.toBeDefined();
  });

  it("approves only by someone who did not write or edit it, then fixes it and puts it in use", async () => {
    const template = await asWriter((c) => newTemplate(c));
    const v1 = await asWriter((c) => draft(c, template));
    // The deputy edits the draft: a contributor now.
    await asNorth((c) =>
      c.query(
        "UPDATE letter_template_version SET body = 'Dear {{recipient.name}}, hello.' WHERE id = $1",
        [v1],
      ),
    );
    await expect(asWriter((c) => approve(c, v1))).rejects.toThrow(/did not write or edit/);
    await expect(asNorth((c) => approve(c, v1))).rejects.toThrow(/did not write or edit/);
    await asManager((c) => approve(c, v1));
    const [row] = await asManager(
      async (c) =>
        (await c.query("SELECT current_version_id FROM letter_template WHERE id = $1", [template]))
          .rows,
    );
    expect(row?.current_version_id).toBe(v1);
    await expect(
      asManager((c) =>
        c.query("UPDATE letter_template_version SET body = 'Changed' WHERE id = $1", [v1]),
      ),
    ).rejects.toThrow(/is fixed/);
    await expect(
      asManager((c) =>
        c.query("UPDATE letter_template SET current_version_id = NULL WHERE id = $1", [template]),
      ),
    ).rejects.toThrow(/changes only by approving or retiring/);
    await expect(
      asManager((c) => c.query("DELETE FROM letter_template_version WHERE id = $1", [v1])),
    ).rejects.toThrow();

    // A new draft: the same words cannot be approved again; a change can, superseding v1.
    const v2 = await asWriter((c) => draft(c, template, "Dear {{recipient.name}}, hello."));
    await expect(asWriter((c) => draft(c, template))).rejects.toThrow(/one_draft_key/);
    await expect(asManager((c) => approve(c, v2))).rejects.toThrow(/differs from the one in use/);
    await asWriter((c) =>
      c.query(
        "UPDATE letter_template_version SET body = 'Dear {{recipient.name}}, welcome home.' WHERE id = $1",
        [v2],
      ),
    );
    await asManager((c) => approve(c, v2));
    const states = await asManager(
      async (c) =>
        (
          await c.query<{ id: string; state: string; version_number: number }>(
            "SELECT id, state, version_number FROM letter_template_version WHERE template_id = $1 ORDER BY version_number",
            [template],
          )
        ).rows,
    );
    expect(states.map((s) => [s.version_number, s.state])).toEqual([
      [1, "superseded"],
      [2, "approved"],
    ]);

    // Retiring takes it out of use; a holder of write alone cannot.
    await expect(
      asWriter((c) =>
        c.query(
          "UPDATE letter_template_version SET state = 'retired', retired_by = app.current_user_id(), retired_at = now(), retirement_reason = 'Replaced' WHERE id = $1",
          [v2],
        ),
      ),
    ).rejects.toThrow(/comms.template.approve/);
    await asManager((c) =>
      c.query(
        "UPDATE letter_template_version SET state = 'retired', retired_by = app.current_user_id(), retired_at = now(), retirement_reason = 'Replaced' WHERE id = $1",
        [v2],
      ),
    );
    const [after] = await asManager(
      async (c) =>
        (await c.query("SELECT current_version_id FROM letter_template WHERE id = $1", [template]))
          .rows,
    );
    expect(after?.current_version_id).toBeNull();
  });
});

describe("hazard HZ-051 letters in the database", () => {
  let approved: string;
  let draftOnly: string;

  beforeAll(async () => {
    const template = await asWriter((c) => newTemplate(c));
    approved = await asWriter((c) => draft(c, template, "Dear {{recipient.name}}, your letter."));
    await asManager((c) => approve(c, approved));
    const other = await asWriter((c) => newTemplate(c));
    draftOnly = await asWriter((c) => draft(c, other));
  });

  it("is made only from an approved version, on its channel, in the sender's name", async () => {
    await expect(
      asNorth((c) => send(c, { version: draftOnly, person: a.personAda })),
    ).rejects.toThrow(/approved template version/);
    await expect(
      asNorth((c) => send(c, { version: approved, person: a.personAda, channel: "email" })),
    ).rejects.toThrow(/letter_delivery|its template's channel/);
    const sent = await asNorth((c) => send(c, { version: approved, person: a.personAda }));
    expect(sent.rows[0]?.id).toBeDefined();
  });

  it("goes only to the person or one of their own contacts, within the sender's scope", async () => {
    await expect(
      asNorth((c) => send(c, { version: approved, person: a.personAda, contact: CONTACT_CARA })),
    ).rejects.toThrow(/letter_contact_fk/);
    await asNorth((c) => send(c, { version: approved, person: a.personAda, contact: CONTACT_ADA }));
    // Cara lives at South: the North deputy can neither send nor see her letters.
    await expect(
      asNorth((c) => send(c, { version: approved, person: a.personCara })),
    ).rejects.toThrow(/row-level security/);
    await asManager((c) => send(c, { version: approved, person: a.personCara }));
    const seen = await asNorth(
      async (c) => (await c.query<{ person_id: string }>("SELECT person_id FROM letter")).rows,
    );
    expect(new Set(seen.map((r) => r.person_id))).toEqual(new Set([a.personAda]));
    // A holder of write alone sends nothing.
    await expect(
      asWriter((c) => send(c, { version: approved, person: a.personAda })),
    ).rejects.toThrow(/row-level security/);
  });

  it("is append-only, and keeps its retention class with its incident grade", async () => {
    await expect(asManager((c) => c.query("UPDATE letter SET channel = 'letter'"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(asManager((c) => c.query("DELETE FROM letter"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO letter (template_version_id, person_id, recipient_kind, channel,
             special_category, incident_serious, retention_class)
           VALUES ($1, $2, 'person', 'letter', true, false, 'serious_incident')`,
          [approved, a.personAda],
        ),
      ),
    ).rejects.toThrow(/letter_retention/);
  });
});

import { createHash } from "node:crypto";
import {
  EVIDENCE_CODE_MAX_VALID_MINUTES,
  EVIDENCE_EXCLUSION_REASONS,
  EVIDENCE_LINK_MAX_CODE_ATTEMPTS,
  EVIDENCE_PACK_WORKFLOW,
  EVIDENCE_RECORD_TYPES,
  MIN_EVIDENCE_PURPOSE_LENGTH,
  STATEMENT_OF_PURPOSE_WORKFLOW,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EVIDENCE_EXCLUSION_REASON_CODES,
  EVIDENCE_PACK_STATES,
  EVIDENCE_RECORD_TYPE_CODES,
  STATEMENT_OF_PURPOSE_STATES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Evidence packs and the statement of purpose in the database (quality.md sections 2 to 4;
 * ADR-0050; hazards HZ-011 and HZ-050; migration 0057): cross-tenant denial, packs only for
 * holders of compose or release at every location who can see every person in scope, append-only
 * items holding outcomes and never values, release and links only by someone who did not shape
 * the pack, hashed tokens and codes, failed attempts that never go down, bundles deleted at link
 * end, the token lookup, and statement of purpose versions fixed once approved, approved by
 * someone who did not write them, with the regulation 12(3) clock.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asReleaser = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const PACK_NORTH = "0199f000-0000-7000-8000-0000000000a1";
const PACK_BOTH = "0199f000-0000-7000-8000-0000000000a2";
const PACK_B = "0199f000-0000-7000-8000-0000000000b1";
const ITEM_NORTH = "0199f000-0000-7000-8000-0000000000c1";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const hash = (text: string) => `encode(sha256(convert_to('${text}', 'UTF8')), 'hex')`;

const insertPack = (
  c: pg.PoolClient,
  values: { id: string; locations: string[]; people: string[]; composedBy?: string },
) =>
  c.query(
    `INSERT INTO evidence_pack (id, recipient_name, recipient_organisation, recipient_email,
       purpose, date_from, date_to, location_ids, person_ids, composed_by, watermark)
     VALUES ($1, 'Ivy Inspector', 'Care Quality Commission', 'ivy.inspector@example.invalid',
       'Evidence of safe care for the planned inspection', '2026-09-01', '2026-09-30', $2, $3,
       COALESCE($4, app.current_user_id()), 'Prepared for Ivy Inspector. Do not share further.')`,
    [values.id, values.locations, values.people, values.composedBy ?? null],
  );

const field = (extra: Record<string, unknown> = {}) =>
  JSON.stringify([
    { key: "type", label: "Type", kind: "organisational", outcome: "included", reason: null },
    {
      key: "description",
      label: "Description",
      kind: "free_text",
      outcome: "withheld",
      reason: "free_text_not_reviewed",
      ...extra,
    },
  ]);

const insertItem = (
  c: pg.PoolClient,
  values: { id?: string; pack: string; fields?: string; supersedes?: string },
) =>
  c.query(
    `INSERT INTO evidence_pack_item (id, pack_id, supersedes_id, record_type, record_id,
       record_version, title, occurred_at, fields)
     VALUES (COALESCE($1, app.uuid_v7()), $2, $3, 'incident', '0199f000-0000-7000-8000-0000000000f1',
       1, 'Incident (fall)', '2026-09-10T10:00:00Z', $4::jsonb)`,
    [values.id ?? null, values.pack, values.supersedes ?? null, values.fields ?? field()],
  );

const insertLink = (
  c: pg.PoolClient,
  values: { pack: string; token: string; email?: string; days?: number; replaces?: string },
) =>
  c.query(
    `INSERT INTO evidence_pack_link (pack_id, recipient_email, token_hash, expires_at,
       replaces_link_id)
     VALUES ($1, $2, ${hash(values.token)}, now() + make_interval(days => $3), $4)
     RETURNING id`,
    [
      values.pack,
      values.email ?? "ivy.inspector@example.invalid",
      values.days ?? 7,
      values.replaces ?? null,
    ],
  );

const count = (c: pg.PoolClient, table: string) =>
  c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`).then((r) => Number(r.rows[0]?.n));

const content = (aims: string) =>
  JSON.stringify({ aimsAndObjectives: aims, locations: [{ id: a.locationNorth, name: "North" }] });

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('evidence_pack.link_expiry_days.max', 30, 'days', 'all', '2000-01-01', 'quality.md', 'to-verify'),
              ('evidence_pack.code_valid_minutes', 10, 'minutes', 'all', '2000-01-01', 'quality.md', 'to-verify'),
              ('cqc.statement_of_purpose.revision_notice_days', 28, 'days', 'england', '2010-04-01',
               'CQC (Registration) Regulations 2009 reg 12(3)', 'verified')`,
    ),
  );
  const quality =
    "{quality.evidence_pack.compose,quality.evidence_pack.release,quality.statement_of_purpose.write,quality.statement_of_purpose.approve,safety.notification.submit,people.person.read}";
  const deputy =
    "{quality.evidence_pack.compose,quality.evidence_pack.release,quality.statement_of_purpose.write,people.person.read}";
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f000-0000-7000-8000-000000000501', 'owner', 'Owner', 'tenant', $1),
         ('0199f000-0000-7000-8000-000000000502', 'deputy_manager', 'Deputy', 'location', $2),
         ('0199f000-0000-7000-8000-000000000504', 'quality_lead', 'Quality lead', 'location',
          '{quality.evidence_pack.compose,quality.evidence_pack.release,people.person.read}')`,
      [quality, deputy],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f000-0000-7000-8000-000000000501', NULL),
         ($2, '0199f000-0000-7000-8000-000000000502', $3),
         ($4, $5, $3),
         ($4, '0199f000-0000-7000-8000-000000000504', $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer, a.roleCarer],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199f000-0000-7000-8000-000000000503', 'owner', 'Owner', 'tenant', $1)`,
      [quality],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199f000-0000-7000-8000-000000000503')`,
      [b.manager],
    );
  });
  await asNorth((c) =>
    insertPack(c, { id: PACK_NORTH, locations: [a.locationNorth], people: [a.personAda] }),
  );
  await asManager(async (c) => {
    await insertPack(c, {
      id: PACK_BOTH,
      locations: [a.locationNorth, a.locationSouth],
      people: [a.personAda, a.personCara],
    });
  });
  await asNorth((c) => insertItem(c, { id: ITEM_NORTH, pack: PACK_NORTH }));
  await asOtherTenant((c) =>
    insertPack(c, { id: PACK_B, locations: [b.location], people: [b.personDev] }),
  );
});

afterAll(async () => {
  await db?.drop();
});

describe("evidence pack and statement of purpose codes match the domain", () => {
  it("keeps the code lists and limits in step", () => {
    expect([...EVIDENCE_PACK_STATES]).toEqual([...EVIDENCE_PACK_WORKFLOW.states]);
    expect([...EVIDENCE_RECORD_TYPE_CODES]).toEqual([...EVIDENCE_RECORD_TYPES]);
    expect([...EVIDENCE_EXCLUSION_REASON_CODES]).toEqual([...EVIDENCE_EXCLUSION_REASONS]);
    expect([...STATEMENT_OF_PURPOSE_STATES]).toEqual([...STATEMENT_OF_PURPOSE_WORKFLOW.states]);
    // The figures migration 0057 writes into its CHECKs and guards.
    expect(MIN_EVIDENCE_PURPOSE_LENGTH).toBe(15);
    expect(EVIDENCE_CODE_MAX_VALID_MINUTES).toBe(10);
    expect(EVIDENCE_LINK_MAX_CODE_ATTEMPTS).toBe(5);
  });
});

describe("hazard HZ-011 evidence pack isolation and scope", () => {
  it("never shows another organisation's packs or statements", async () => {
    const seen = await asOtherTenant((c) =>
      c.query<{ id: string }>("SELECT id FROM evidence_pack ORDER BY id"),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([PACK_B]);
    expect(await asOtherTenant((c) => count(c, "evidence_pack_item"))).toBe(0);
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO evidence_pack_item (tenant_id, pack_id, record_type, record_id,
          record_version, title, occurred_at) VALUES ($1, $2, 'incident', app.uuid_v7(), 1, 'x', now())`,
          [TENANT_A, PACK_NORTH],
        ),
      ),
    ).rejects.toThrow(/row-level security|only to a draft/);
  });

  it("shows a pack only to holders at every one of its locations who can see everyone in it", async () => {
    const ids = (c: pg.PoolClient) =>
      c
        .query<{ id: string }>("SELECT id FROM evidence_pack ORDER BY id")
        .then((r) => r.rows.map((x) => x.id));
    expect(await asManager(ids)).toEqual([PACK_NORTH, PACK_BOTH]);
    expect(await asNorth(ids)).toEqual([PACK_NORTH]);
    expect(await asCarer(ids)).toEqual([]);
    expect(await asCarer((c) => count(c, "evidence_pack_item"))).toBe(0);
  });

  it("composes in the composer's own name, at locations where they hold compose", async () => {
    await expect(
      asNorth((c) =>
        insertPack(c, {
          id: "0199f000-0000-7000-8000-0000000000a9",
          locations: [a.locationNorth],
          people: [a.personAda],
          composedBy: a.manager,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      inContext(app(), ctx(TENANT_A, a.northManager, "tenant"), (c) =>
        insertPack(c, {
          id: "0199f000-0000-7000-8000-0000000000aa",
          locations: [a.locationSouth],
          people: [a.personCara],
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps the request fixed once composed", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE evidence_pack SET person_ids = $2 WHERE id = $1", [
          PACK_BOTH,
          [a.personAda, a.personBen, a.personCara],
        ]),
      ),
    ).rejects.toThrow(/request is fixed/);
  });
});

describe("hazard HZ-050 evidence pack items, release and links in the database", () => {
  it("holds outcomes from the domain's lists and never a value", async () => {
    await expect(
      asNorth((c) => insertItem(c, { pack: PACK_NORTH, fields: field({ value: "Ada fell" }) })),
    ).rejects.toThrow(/no values/);
    await expect(
      asNorth((c) => insertItem(c, { pack: PACK_NORTH, fields: field({ kind: "gossip" }) })),
    ).rejects.toThrow(/no values/);
    // No redacted copy and no long free text in the manifest: they would outlive the bundle.
    await expect(
      asNorth((c) =>
        insertItem(c, {
          pack: PACK_NORTH,
          fields: field({ label: "Who was there: Ada's son Jo Example and ".repeat(3) }),
        }),
      ),
    ).rejects.toThrow(/no values/);
    await expect(
      asNorth((c) =>
        insertItem(c, {
          pack: PACK_NORTH,
          supersedes: ITEM_NORTH,
          fields: field({
            outcome: "redacted",
            reason: "free_text_redacted_by_hand",
            redactedBy: a.northManager,
            redactedText: "[relative] was told.",
          }),
        }),
      ),
    ).rejects.toThrow(/no values/);
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO evidence_pack_item (pack_id, record_type, record_id, record_version, title,
             occurred_at) VALUES ($1, 'incident', app.uuid_v7(), 1, $2, now())`,
          [PACK_NORTH, "x".repeat(121)],
        ),
      ),
    ).rejects.toThrow(/evidence_pack_item_title/);
  });

  it("keeps items append-only", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE evidence_pack_item SET title = 'x' WHERE id = $1", [ITEM_NORTH]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("records a hand redaction in the redactor's name, and makes them an editor", async () => {
    const redacted = field({
      outcome: "redacted",
      reason: "free_text_redacted_by_hand",
      redactedBy: a.northManager,
    });
    await expect(
      asManager((c) =>
        insertItem(c, { pack: PACK_NORTH, fields: redacted, supersedes: ITEM_NORTH }),
      ),
    ).rejects.toThrow(/in the name of the member redacting/);
    const mine = field({
      outcome: "redacted",
      reason: "free_text_redacted_by_hand",
      redactedBy: a.manager,
    });
    await asManager((c) =>
      insertItem(c, { pack: PACK_NORTH, fields: mine, supersedes: ITEM_NORTH }),
    );
    const pack = await asSystem((c) =>
      c.query<{ editor_ids: string[] }>("SELECT editor_ids FROM evidence_pack WHERE id = $1", [
        PACK_NORTH,
      ]),
    );
    expect(pack.rows[0]?.editor_ids).toEqual([a.manager]);
  });

  it("never lets anyone who shaped the pack release it, and never an empty pack", async () => {
    const release = (c: pg.PoolClient, id: string) =>
      c.query(
        "UPDATE evidence_pack SET state = 'released', released_by = app.current_user_id(), released_at = now() WHERE id = $1",
        [id],
      );
    await expect(asNorth((c) => release(c, PACK_NORTH))).rejects.toThrow(/may release it/);
    await expect(asManager((c) => release(c, PACK_NORTH))).rejects.toThrow(/may release it/);
    // Not a holder at every location: the pack is out of reach.
    const outside = await inContext(app(), ctx(TENANT_A, a.northManager, "tenant"), (c) =>
      release(c, PACK_BOTH),
    );
    expect(outside.rowCount).toBe(0);
    const empty = "0199f000-0000-7000-8000-0000000000a6";
    await asManager((c) =>
      insertPack(c, { id: empty, locations: [a.locationNorth], people: [a.personAda] }),
    );
    await expect(asNorth((c) => release(c, empty))).rejects.toThrow(/no items/);
  });

  it("releases by a non-contributor, then issues hashed links to the recipient alone", async () => {
    const pack = "0199f000-0000-7000-8000-0000000000a3";
    await asManager(async (c) => {
      await insertPack(c, { id: pack, locations: [a.locationNorth], people: [a.personAda] });
      await insertItem(c, { pack });
    });
    await asNorth((c) =>
      c.query(
        "UPDATE evidence_pack SET state = 'released', released_by = app.current_user_id(), released_at = now() WHERE id = $1",
        [pack],
      ),
    );
    await expect(asNorth((c) => insertItem(c, { pack }))).rejects.toThrow(/only to a draft/);
    await expect(
      asNorth((c) => insertLink(c, { pack, token: "t1", email: "someone.else@example.invalid" })),
    ).rejects.toThrow(/recipient only/);
    await expect(asManager((c) => insertLink(c, { pack, token: "t1" }))).rejects.toThrow(
      /may issue its link/,
    );
    await expect(asNorth((c) => insertLink(c, { pack, token: "t1", days: 31 }))).rejects.toThrow(
      /link_expiry_days.max/,
    );
    const first = await asNorth((c) => insertLink(c, { pack, token: "t1" }));
    const firstId = first.rows[0]?.id as string;
    const stored = await asSystem((c) =>
      c.query<{ token_hash: string }>("SELECT token_hash FROM evidence_pack_link WHERE id = $1", [
        firstId,
      ]),
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toContain("t1");

    // The token lookup, before any organisation is chosen.
    const found = await inContext(app(), null, (c) =>
      c.query("SELECT * FROM app.evidence_pack_link_for_token($1)", [sha256("t1")]),
    );
    expect(found.rows).toEqual([{ tenant_id: TENANT_A, link_id: firstId, pack_id: pack }]);
    const unknown = await inContext(app(), null, (c) =>
      c.query("SELECT * FROM app.evidence_pack_link_for_token($1)", [sha256("nope")]),
    );
    expect(unknown.rows).toEqual([]);
    // The raw token is never accepted.
    const raw = await inContext(app(), null, (c) =>
      c.query("SELECT * FROM app.evidence_pack_link_for_token($1)", ["t1"]),
    );
    expect(raw.rows).toEqual([]);

    // A new link only replaces the last, revoked as re-issued in the same transaction.
    await expect(asNorth((c) => insertLink(c, { pack, token: "t2" }))).rejects.toThrow(
      /link_live_key|replaces the pack's last link/,
    );
    await asNorth(async (c) => {
      await c.query(
        "UPDATE evidence_pack_link SET revoked_at = now(), revoked_by = app.current_user_id(), revocation_reason = 'reissued' WHERE id = $1",
        [firstId],
      );
      await insertLink(c, { pack, token: "t2", replaces: firstId });
    });
    await expect(
      asSystem((c) =>
        c.query("UPDATE evidence_pack_link SET failed_code_attempts = 1 WHERE id = $1", [firstId]),
      ),
    ).rejects.toThrow(/revoked link is final/);
  });

  it("counts failed codes up only, issues codes with a worked-out lifetime, used once", async () => {
    const pack = "0199f000-0000-7000-8000-0000000000a4";
    await asManager(async (c) => {
      await insertPack(c, { id: pack, locations: [a.locationNorth], people: [a.personAda] });
      await insertItem(c, { pack });
    });
    const linkId = await asNorth(async (c) => {
      await c.query(
        "UPDATE evidence_pack SET state = 'released', released_by = app.current_user_id(), released_at = now() WHERE id = $1",
        [pack],
      );
      return (await insertLink(c, { pack, token: "t3" })).rows[0]?.id as string;
    });
    const code = await asSystem((c) =>
      c.query<{ id: string; minutes: number }>(
        `INSERT INTO evidence_pack_link_code (link_id, code_hash, valid_until)
         VALUES ($1, ${hash("123456")}, now() + interval '1 hour')
         RETURNING id, extract(epoch FROM valid_until - issued_at) / 60 AS minutes`,
        [linkId],
      ),
    );
    expect(Number(code.rows[0]?.minutes)).toBe(10);
    const codeId = code.rows[0]?.id as string;
    await expect(
      asSystem((c) =>
        c.query("UPDATE evidence_pack_link_code SET code_hash = $2 WHERE id = $1", [
          codeId,
          "0".repeat(64),
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await asSystem((c) =>
      c.query("UPDATE evidence_pack_link_code SET used_at = now() WHERE id = $1", [codeId]),
    );
    await expect(
      asSystem((c) =>
        c.query("UPDATE evidence_pack_link_code SET used_at = now() WHERE id = $1", [codeId]),
      ),
    ).rejects.toThrow(/only marked used, once/);

    await asSystem((c) =>
      c.query("UPDATE evidence_pack_link SET last_opened_at = now() WHERE id = $1", [linkId]),
    );
    await expect(
      asSystem((c) =>
        c.query("UPDATE evidence_pack_link SET failed_code_attempts = 0 WHERE id = $1", [linkId]),
      ),
    ).resolves.toBeDefined();
    await asSystem((c) =>
      c.query("UPDATE evidence_pack_link SET failed_code_attempts = 5 WHERE id = $1", [linkId]),
    );
    await expect(
      asSystem((c) =>
        c.query("UPDATE evidence_pack_link SET failed_code_attempts = 4 WHERE id = $1", [linkId]),
      ),
    ).rejects.toThrow(/never go down/);
    // Locked: no more codes, no more opens.
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO evidence_pack_link_code (link_id, code_hash, valid_until)
           VALUES ($1, ${hash("654321")}, now() + interval '5 minutes')`,
          [linkId],
        ),
      ),
    ).rejects.toThrow(/only for a live link/);
    await expect(
      asSystem((c) =>
        c.query("UPDATE evidence_pack_link SET last_opened_at = now() WHERE id = $1", [linkId]),
      ),
    ).rejects.toThrow(/only while it is live/);
  });

  it("makes whoever changes the shown values an editor, who may not release or link", async () => {
    const pack = "0199f000-0000-7000-8000-0000000000a7";
    await asManager(async (c) => {
      await insertPack(c, { id: pack, locations: [a.locationNorth], people: [a.personAda] });
      await insertItem(c, { pack });
      await c.query(
        `INSERT INTO evidence_pack_bundle (pack_id, content) VALUES ($1, '{"i": {"type": "Fall"}}')`,
        [pack],
      );
    });
    await asNorth((c) =>
      c.query(
        `UPDATE evidence_pack_bundle SET content = '{"i": {"type": "Slip"}}' WHERE pack_id = $1`,
        [pack],
      ),
    );
    const release = (c: pg.PoolClient) =>
      c.query(
        "UPDATE evidence_pack SET state = 'released', released_by = app.current_user_id(), released_at = now() WHERE id = $1",
        [pack],
      );
    await expect(asNorth(release)).rejects.toThrow(/may release it/);
    await asReleaser(release);
    await expect(asNorth((c) => insertLink(c, { pack, token: "t5" }))).rejects.toThrow(
      /may issue its link/,
    );
    await asReleaser((c) => insertLink(c, { pack, token: "t5" }));
  });

  it("changes a bundle only in a draft, and deletes it for good when the pack ends", async () => {
    const pack = "0199f000-0000-7000-8000-0000000000a5";
    await asManager(async (c) => {
      await insertPack(c, { id: pack, locations: [a.locationNorth], people: [a.personAda] });
      await insertItem(c, { pack });
      await c.query(
        `INSERT INTO evidence_pack_bundle (pack_id, content) VALUES ($1, '{"i": {"type": "Fall"}}')`,
        [pack],
      );
    });
    await asNorth(async (c) => {
      await c.query(
        "UPDATE evidence_pack SET state = 'released', released_by = app.current_user_id(), released_at = now() WHERE id = $1",
        [pack],
      );
      await insertLink(c, { pack, token: "t4" });
    });
    await expect(
      asManager((c) =>
        c.query("UPDATE evidence_pack_bundle SET content = '{}' WHERE pack_id = $1", [pack]),
      ),
    ).rejects.toThrow(/only while its pack is a draft/);
    const remove = (c: pg.PoolClient, reason: string) =>
      c.query(
        "UPDATE evidence_pack_bundle SET content = NULL, deleted_at = now(), deletion_reason = $2 WHERE pack_id = $1",
        [pack, reason],
      );
    await expect(asManager((c) => remove(c, "link_ended"))).rejects.toThrow(/link ends/);
    await asManager(async (c) => {
      await c.query(
        "UPDATE evidence_pack SET state = 'revoked', revoked_by = app.current_user_id(), revoked_at = now(), revocation_reason = 'Inspection postponed' WHERE id = $1",
        [pack],
      );
      await remove(c, "pack_revoked");
    });
    await expect(
      asManager((c) =>
        c.query(
          "UPDATE evidence_pack_bundle SET content = '{}', deleted_at = NULL, deletion_reason = NULL WHERE pack_id = $1",
          [pack],
        ),
      ),
    ).rejects.toThrow(/never restored/);
    await expect(
      asManager((c) =>
        c.query("UPDATE evidence_pack SET state = 'released' WHERE id = $1", [pack]),
      ),
    ).rejects.toThrow(/final/);
  });
});

describe("statement of purpose versions in the database", () => {
  const draft = (c: pg.PoolClient, kind: string, aims: string) =>
    c
      .query<{ id: string; version_number: number }>(
        "INSERT INTO statement_of_purpose_version (kind, content) VALUES ($1, $2::jsonb) RETURNING id, version_number",
        [kind, content(aims)],
      )
      .then((r) => r.rows[0] as { id: string; version_number: number });
  const approve = (c: pg.PoolClient, id: string) =>
    c.query(
      "UPDATE statement_of_purpose_version SET state = 'approved', approved_by = app.current_user_id(), approved_at = now() WHERE id = $1 RETURNING notification_due_at, approved_at",
      [id],
    );

  it("approves only by someone who did not write it, and fixes what is approved", async () => {
    await expect(asNorth((c) => draft(c, "revision", "Aims one"))).rejects.toThrow(/baseline/);
    const baseline = await asNorth((c) => draft(c, "baseline", "Aims one"));
    expect(baseline.version_number).toBe(1);
    await expect(asNorth((c) => approve(c, baseline.id))).rejects.toThrow(/did not write or edit/);
    const done = await asManager((c) => approve(c, baseline.id));
    expect(done.rows[0]?.notification_due_at).toBeNull();
    await expect(
      asManager((c) =>
        c.query("UPDATE statement_of_purpose_version SET content = '{}' WHERE id = $1", [
          baseline.id,
        ]),
      ),
    ).rejects.toThrow(/fixed/);
    await expect(
      asManager((c) =>
        c.query("UPDATE statement_of_purpose_version SET state = 'superseded' WHERE id = $1", [
          baseline.id,
        ]),
      ),
    ).rejects.toThrow(/only by approving the next/);
    await expect(asOtherTenant((c) => count(c, "statement_of_purpose_version"))).resolves.toBe(0);
    await expect(asCarer((c) => count(c, "statement_of_purpose_version"))).resolves.toBe(0);

    // An editor of the draft is a contributor; the same content cannot be approved again.
    const same = await asNorth((c) => draft(c, "revision", "Aims one"));
    await expect(asManager((c) => approve(c, same.id))).rejects.toThrow(/differs/);
    await asManager((c) =>
      c.query("UPDATE statement_of_purpose_version SET content = $2::jsonb WHERE id = $1", [
        same.id,
        content("Aims two"),
      ]),
    );
    await expect(asManager((c) => approve(c, same.id))).rejects.toThrow(/did not write or edit/);
    await asNorth((c) =>
      c.query(
        "UPDATE statement_of_purpose_version SET state = 'discarded', discard_reason = 'Started again' WHERE id = $1",
        [same.id],
      ),
    );

    // A revision supersedes the baseline and starts the regulation 12(3) clock.
    const revision = await asNorth((c) => draft(c, "revision", "Aims three"));
    const approved = await asManager((c) => approve(c, revision.id));
    const row = approved.rows[0] as { notification_due_at: Date; approved_at: Date };
    const days = (row.notification_due_at.getTime() - row.approved_at.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(28);
    const states = await asManager((c) =>
      c.query<{ id: string; state: string; supersedes_id: string | null }>(
        "SELECT id, state, supersedes_id FROM statement_of_purpose_version ORDER BY version_number",
      ),
    );
    expect(states.rows.map((r) => r.state)).toEqual(["superseded", "discarded", "approved"]);
    expect(states.rows[2]?.supersedes_id).toBe(baseline.id);

    // The notification is recorded once, by a holder of safety.notification.submit.
    const notify = (c: pg.PoolClient) =>
      c.query(
        "UPDATE statement_of_purpose_version SET notified_at = now(), notified_by = app.current_user_id(), notification_evidence = 'CQC portal reference 0001' WHERE id = $1",
        [revision.id],
      );
    await expect(asNorth(notify)).rejects.toThrow(/safety.notification.submit/);
    await asManager(notify);
    await expect(asManager(notify)).rejects.toThrow(/recorded once/);
  });
});

describe("hazard HZ-011 cross-tenant denial for every evidence pack and statement table", () => {
  // Each insert names another organisation's row. It is refused by row-level security, or by the
  // table's guard, which cannot see the hidden parent under it; never by a key or grant error.
  const cases: [string, string, unknown[], RegExp][] = [
    [
      "evidence_pack_link",
      `INSERT INTO evidence_pack_link (tenant_id, pack_id, recipient_email, token_hash, expires_at)
       VALUES ($1, $2, 'ivy.inspector@example.invalid', ${hash("tb")}, now() + interval '1 day')`,
      [TENANT_A, PACK_NORTH],
      /only for a released evidence pack|row-level security/,
    ],
    [
      "evidence_pack_link_code",
      `INSERT INTO evidence_pack_link_code (tenant_id, link_id, code_hash, valid_until)
       VALUES ($1, $2, ${hash("000000")}, now() + interval '5 minutes')`,
      [TENANT_A],
      /only for a live link|row-level security/,
    ],
    [
      "evidence_pack_bundle",
      "INSERT INTO evidence_pack_bundle (tenant_id, pack_id, content) VALUES ($1, $2, '{}')",
      [TENANT_A, PACK_NORTH],
      /for a draft evidence pack|row-level security/,
    ],
    [
      "statement_of_purpose_version",
      `INSERT INTO statement_of_purpose_version (tenant_id, kind, content)
       VALUES ($1, 'baseline', '{}')`,
      [TENANT_A],
      /row-level security/,
    ],
  ];

  it.each(cases)(
    "denies %s across organisations, to read and to write",
    async (table, insert, params, refusal) => {
      // A code's only writable column is used_at (a column grant).
      const column = table === "evidence_pack_link_code" ? "used_at" : "tenant_id";
      const ofA = `SELECT count(*) AS n FROM ${table} WHERE tenant_id = '${TENANT_A}'`;
      const own = await asManager((c) => c.query<{ n: string }>(ofA));
      expect(Number(own.rows[0]?.n)).toBeGreaterThan(0);
      const seen = await asOtherTenant((c) => c.query<{ n: string }>(ofA));
      expect(Number(seen.rows[0]?.n)).toBe(0);
      const changed = await asOtherTenant((c) =>
        c.query(`UPDATE ${table} SET ${column} = ${column} WHERE tenant_id = $1`, [TENANT_A]),
      );
      expect(changed.rowCount).toBe(0);
      // A code names one of the organisation's real links, so a missing key cannot pass for a refusal.
      const values =
        table === "evidence_pack_link_code"
          ? [
              ...params,
              (
                await asManager((c) =>
                  c.query<{ id: string }>("SELECT id FROM evidence_pack_link LIMIT 1"),
                )
              ).rows[0]?.id,
            ]
          : params;
      await expect(asOtherTenant((c) => c.query(insert, values))).rejects.toThrow(refusal);
    },
  );
});

describe("hazard HZ-050 a link session reaches its own link alone (migration 0058)", () => {
  const PACK_1 = "0199f000-0000-7000-8000-0000000000d1";
  const PACK_2 = "0199f000-0000-7000-8000-0000000000d2";
  let link1: string;
  let link2: string;
  const asLink = <T>(fn: (c: pg.PoolClient) => Promise<T>, scope: "none" | "tenant" = "none") =>
    inContext(
      app(),
      { ...ctx(TENANT_A, null, scope), evidenceLink: { linkId: link1, packId: PACK_1 } },
      fn,
    );

  beforeAll(async () => {
    for (const [pack, token] of [
      [PACK_1, "session-1"],
      [PACK_2, "session-2"],
    ] as const) {
      await asManager(async (c) => {
        await insertPack(c, { id: pack, locations: [a.locationNorth], people: [a.personAda] });
        await insertItem(c, { pack });
        await c.query(
          `INSERT INTO evidence_pack_bundle (pack_id, content) VALUES ($1, '{"i": {"type": "Fall"}}')`,
          [pack],
        );
      });
      const id = await asNorth(async (c) => {
        await c.query(
          "UPDATE evidence_pack SET state = 'released', released_by = app.current_user_id(), released_at = now() WHERE id = $1",
          [pack],
        );
        return (await insertLink(c, { pack, token })).rows[0]?.id as string;
      });
      if (pack === PACK_1) link1 = id;
      else link2 = id;
    }
  });

  it("sees its link, its pack, the pack's items and bundle, and nothing else", async () => {
    await asLink(async (c) => {
      const packs = await c.query<{ id: string }>("SELECT id FROM evidence_pack");
      expect(packs.rows.map((r) => r.id)).toEqual([PACK_1]);
      const links = await c.query<{ id: string }>("SELECT id FROM evidence_pack_link");
      expect(links.rows.map((r) => r.id)).toEqual([link1]);
      const items = await c.query<{ pack_id: string }>("SELECT pack_id FROM evidence_pack_item");
      expect(new Set(items.rows.map((r) => r.pack_id))).toEqual(new Set([PACK_1]));
      expect(await count(c, "evidence_pack_bundle")).toBe(1);
      expect(await count(c, "statement_of_purpose_version")).toBe(0);
      expect(await count(c, "person")).toBe(0);
    });
  });

  it("is held to its link even if it claims the organisation's scope", async () => {
    // The API never does this (`assertValidContext` refuses it); the database holds the line too.
    await asLink(async (c) => {
      const packs = await c.query<{ id: string }>("SELECT id FROM evidence_pack");
      expect(packs.rows.map((r) => r.id)).toEqual([PACK_1]);
      expect(await count(c, "evidence_pack_link")).toBe(1);
      expect(await count(c, "statement_of_purpose_version")).toBe(0);
    }, "tenant");
  });

  it("counts a wrong code and issues a code on its own link, and on no other", async () => {
    await asLink(async (c) => {
      const counted = await c.query(
        "UPDATE evidence_pack_link SET failed_code_attempts = failed_code_attempts + 1 WHERE id = $1",
        [link1],
      );
      expect(counted.rowCount).toBe(1);
      const other = await c.query(
        "UPDATE evidence_pack_link SET failed_code_attempts = failed_code_attempts + 1 WHERE id = $1",
        [link2],
      );
      expect(other.rowCount).toBe(0);
      await c.query(
        `INSERT INTO evidence_pack_link_code (link_id, code_hash, valid_until)
         VALUES ($1, ${hash("111111")}, now() + interval '5 minutes')`,
        [link1],
      );
    });
    await expect(
      asLink((c) =>
        c.query(
          `INSERT INTO evidence_pack_link_code (link_id, code_hash, valid_until)
           VALUES ($1, ${hash("222222")}, now() + interval '5 minutes')`,
          [link2],
        ),
      ),
      // The issue trigger cannot see the other link, so refuses it as not live; RLS would too.
    ).rejects.toThrow(/row-level security|only for a live link/);
  });

  it("only reads the pack, items and bundle: no revoking, discarding or deleting them", async () => {
    await asLink(async (c) => {
      const revoked = await c.query(
        "UPDATE evidence_pack SET state = 'revoked', revoked_at = now(), revocation_reason = 'x' WHERE id = $1",
        [PACK_1],
      );
      expect(revoked.rowCount).toBe(0);
      const cleared = await c.query(
        "UPDATE evidence_pack_bundle SET content = NULL, deleted_at = now(), deletion_reason = 'link_ended' WHERE pack_id = $1",
        [PACK_1],
      );
      expect(cleared.rowCount).toBe(0);
    });
    await expect(asLink((c) => insertItem(c, { pack: PACK_1 }))).rejects.toThrow(
      /row-level security|only to a draft/,
    );
  });

  it("reads none of the audit trail, staff, alerts, tasks or grants, yet writes its own audit rows", async () => {
    await asLink(async (c) => {
      await c.query(
        "INSERT INTO audit_event (tenant_id, action, resource_type, resource_id) VALUES ($1, 'quality.evidence_pack.opened', 'evidence_pack_link', $2)",
        [TENANT_A, link1],
      );
      for (const table of [
        "audit_event",
        "tenant_user",
        "notification",
        "task",
        "role_assignment",
      ]) {
        expect(await count(c, table)).toBe(0);
      }
    });
    expect(await asSystem((c) => count(c, "tenant_user"))).toBeGreaterThan(0);
  });

  it("never revokes its own link", async () => {
    await expect(
      asLink((c) =>
        c.query(
          "UPDATE evidence_pack_link SET revoked_at = now(), revocation_reason = 'pack_revoked' WHERE id = $1",
          [link1],
        ),
      ),
    ).rejects.toThrow(/cannot revoke its link/);
  });
});

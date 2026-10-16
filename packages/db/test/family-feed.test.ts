import { checkFeedItemVisibility, type FeedItem, type SharingDecision } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The family feed in the database (comms.md section 2.1; ADR-0061; hazards HZ-022 and HZ-011;
 * migration 0061): a family session reaches no staff table, sees an update only when
 * `app.family_can_see` finds a sharing decision for one of its own contacts, and that function
 * agrees with the domain rule (`checkFeedItemVisibility`) over the same fixtures.
 */

let db: TestDatabase;
const a = ids.a;
const FAMILY = "0199f000-0000-7000-8000-0000000000f1";
const ROLE = "0199f000-0000-7000-8000-000000000501";
let eve: string;
let gus: string;
let finn: string;
let itemAda: string;
let itemBen: string;

const owner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, a.manager, "tenant"), fn);
const family = <T>(fn: (c: pg.PoolClient) => Promise<T>, tenant = TENANT_A) =>
  inContext(db.pool("harbour_app"), { ...ctx(tenant, FAMILY, "none"), family: true }, fn);
const manager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_app"), ctx(TENANT_A, a.manager, "tenant"), fn);
const rows = async (c: pg.PoolClient, sql: string, params: unknown[] = []) =>
  (await c.query(sql, params)).rows;
const DAY = 86_400_000;

interface DecisionCase {
  readonly contact?: () => string;
  readonly sections?: string[];
  readonly carePlanDomains?: string[] | null;
  readonly basis?: string;
  readonly consentGivenBy?: string | null;
  readonly capacity?: string;
  readonly authority?: { role: string; reference: string | null; validUntil: string | null };
  readonly from?: number;
  readonly to?: number;
  readonly withdrawn?: number;
  readonly suspended?: number;
  readonly period?: [number, number | null];
}

const insertDecision = (c: pg.PoolClient, person: string, d: DecisionCase, now: number) =>
  rows(
    c,
    `INSERT INTO sharing_decision (person_id, recipient_kind, recipient_contact_id, sections,
       care_plan_domains, basis, consent_given_by, capacity, authority_role, authority_contact_id,
       authority_reference, authority_valid_until, valid_from, valid_to, withdrawn_at,
       withdrawn_reason, suspended_at, suspended_reason)
     VALUES ($1, 'family', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       CASE WHEN $14::timestamptz IS NULL THEN NULL ELSE 'Withdrawn' END, $15,
       CASE WHEN $15::timestamptz IS NULL THEN NULL ELSE 'Suspended' END) RETURNING id`,
    [
      person,
      (d.contact ?? (() => eve))(),
      d.sections ?? ["daily_updates"],
      d.carePlanDomains ?? null,
      d.basis ?? "consent",
      d.consentGivenBy === undefined ? "person" : d.consentGivenBy,
      d.capacity ?? "presumed",
      d.authority?.role ?? null,
      d.authority ? (d.contact ?? (() => eve))() : null,
      d.authority?.reference ?? null,
      d.authority?.validUntil ?? null,
      new Date(now + (d.from ?? -10 * DAY)),
      new Date(now + (d.to ?? 30 * DAY)),
      d.withdrawn === undefined ? null : new Date(now + d.withdrawn),
      d.suspended === undefined ? null : new Date(now + d.suspended),
    ],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Fay Family', 'fay.family@example.invalid', 'active')`,
      [FAMILY],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES ($1, 'deputy_manager',
         'Deputy', 'tenant', '{people.person.read,people.sharing.manage,comms.feed.publish,comms.feed.withdraw}')`,
      [ROLE],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE,
    ]);
    const contacts = await rows(c, "SELECT id, given_name FROM contact ORDER BY given_name");
    const byName = (n: string) => contacts.find((r) => r.given_name === n)?.id as string;
    [eve, finn, gus] = [byName("Eve"), byName("Finn"), byName("Gus")];
  });
  await manager(async (c) => {
    await c.query(
      `INSERT INTO family_portal_user (tenant_user_id, person_id, contact_id)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [FAMILY, a.personAda, eve, a.personCara, gus],
    );
    const item = (person: string) =>
      rows(
        c,
        `INSERT INTO feed_item (person_id, kind, section, source_kind, source_id, occurred_at, text)
         VALUES ($1, 'shared_note', 'daily_updates', 'shared_note', app.uuid_v7(),
           now() - interval '1 day', 'Joined the garden club.') RETURNING id`,
        [person],
      );
    itemAda = (await item(a.personAda))[0]?.id;
    itemBen = (await item(a.personBen))[0]?.id;
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-022 app.family_can_see agrees with checkFeedItemVisibility", () => {
  const cases: readonly [string, DecisionCase | null, { domain?: string; at?: number }?][] = [
    ["a decision in force", {}],
    ["no decision", null],
    ["a section not named", { sections: ["photos"] }],
    ["an update from before the decision", { from: -12 * 3_600_000 }],
    ["a withdrawn decision", { withdrawn: -3_600_000 }],
    ["a suspended decision", { suspended: -3_600_000 }],
    ["an update from a suspension since lifted", { period: [-2 * DAY, -12 * 3_600_000] }],
    ["a suspension lifted before the update", { period: [-5 * DAY, -3 * DAY] }],
    ["an expired decision", { to: -3_600_000 }],
    ["a decision not yet in force", { from: DAY, to: 10 * DAY }],
    ["another contact's decision", { contact: () => finn }],
    [
      "a care plan domain named",
      { sections: ["care_plan"], carePlanDomains: ["mobility"] },
      { domain: "mobility" },
    ],
    [
      "a care plan domain not named",
      { sections: ["care_plan"], carePlanDomains: ["mobility"] },
      { domain: "sleep" },
    ],
    [
      "a welfare attorney with capacity presumed now",
      {
        contact: () => gus,
        basis: "legal_authority",
        consentGivenBy: null,
        capacity: "assessed_lacks_capacity",
        authority: { role: "lpa_health_welfare", reference: "LPA-1", validUntil: null },
      },
    ],
    [
      "a finance attorney shown daily updates",
      {
        contact: () => gus,
        basis: "legal_authority",
        consentGivenBy: null,
        authority: { role: "lpa_property_finance", reference: "LPA-2", validUntil: null },
      },
    ],
    [
      "a finance attorney shown finance",
      {
        contact: () => gus,
        sections: ["finance"],
        basis: "legal_authority",
        consentGivenBy: null,
        authority: { role: "lpa_property_finance", reference: "LPA-3", validUntil: null },
      },
    ],
    [
      "a lapsed authority",
      {
        contact: () => gus,
        sections: ["finance"],
        basis: "legal_authority",
        consentGivenBy: null,
        authority: { role: "lpa_property_finance", reference: "LPA-4", validUntil: "2020-01-01" },
      },
    ],
  ];

  it.each(cases)("%s", async (_name, decision, item = {}) => {
    await inContext(db.pool("harbour_owner"), ctx(TENANT_A, a.manager, "tenant"), async (c) => {
      await c.query("SAVEPOINT parity");
      const now = new Date((await rows(c, "SELECT now() AS now"))[0]?.now).getTime();
      const contactOf = decision?.contact?.() ?? eve;
      const person =
        contactOf === gus ? a.personCara : contactOf === finn ? a.personBen : a.personAda;
      const kind = item.domain
        ? "care_plan_update"
        : decision?.sections?.[0] === "finance"
          ? "finance_statement"
          : "shared_note";
      const section = {
        care_plan_update: "care_plan",
        finance_statement: "finance",
        shared_note: "daily_updates",
      }[kind];
      const occurredAt = new Date(now + (item.at ?? -DAY));
      const stored: SharingDecision[] = [];
      if (decision) {
        const [row] = await insertDecision(c, person, decision, now);
        if (decision.period) {
          await c.query(
            `INSERT INTO sharing_decision_suspension (person_id, sharing_decision_id, suspended_at,
               reason, lifted_at, lifted_by, lifted_reason) VALUES ($1, $2, $3, 'Enquiry', $4, $5, 'Done')`,
            [
              person,
              row?.id,
              new Date(now + decision.period[0]),
              decision.period[1] === null ? null : new Date(now + decision.period[1]),
              a.manager,
            ],
          );
        }
        const contact = (decision.contact ?? (() => eve))();
        stored.push({
          id: row?.id,
          personId: person,
          recipient: { kind: "family", contactId: contact },
          sections: decision.sections ?? ["daily_updates"],
          carePlanDomains: decision.carePlanDomains ?? "all",
          basis: (decision.basis ?? "consent") as SharingDecision["basis"],
          consentGivenBy: (decision.consentGivenBy === undefined
            ? "person"
            : decision.consentGivenBy) as SharingDecision["consentGivenBy"],
          capacity: (decision.capacity ?? "presumed") as SharingDecision["capacity"],
          authority: decision.authority
            ? {
                role: decision.authority.role as "appointee",
                contactId: contact,
                reference: decision.authority.reference,
                evidenceDocumentId: null,
                validUntil: decision.authority.validUntil,
              }
            : null,
          validFrom: new Date(now + (decision.from ?? -10 * DAY)),
          validTo: new Date(now + (decision.to ?? 30 * DAY)),
          withdrawnAt: decision.withdrawn === undefined ? null : new Date(now + decision.withdrawn),
          suspendedAt: decision.suspended === undefined ? null : new Date(now + decision.suspended),
          suspensions: decision.period
            ? [
                {
                  from: new Date(now + decision.period[0]),
                  to: decision.period[1] === null ? null : new Date(now + decision.period[1]),
                },
              ]
            : [],
        });
      }
      await c.query(
        "SELECT set_config('app.user_id', $1, true), set_config('app.scope', 'none', true), set_config('app.family', 'true', true)",
        [FAMILY],
      );
      const [sql] = await rows(c, "SELECT app.family_can_see($1, $2, $3, $4) AS sees", [
        person,
        section,
        item.domain ?? null,
        occurredAt,
      ]);
      const feedItem: FeedItem = {
        id: "item",
        personId: person,
        kind: kind as FeedItem["kind"],
        carePlanDomain: item.domain ?? null,
        occurredAt,
        composedAt: occurredAt,
        text: "Text",
        photoDocumentId: null,
        supersedesItemId: null,
        withdrawnAt: null,
        withdrawnReason: null,
      };
      // The family member is both contacts (their two links); either may hold the decision.
      const domain = [eve, gus].some(
        (contactId) =>
          checkFeedItemVisibility(feedItem, {
            person: { id: person, status: "active" },
            contactId,
            decisions: stored,
            capacityForSharingNow: "presumed",
            photoBasis: null,
            now: new Date(now),
          }).visible,
      );
      expect(sql?.sees).toBe(domain);
      await c.query("ROLLBACK TO SAVEPOINT parity");
    });
  });

  it("is false outside a family session and for another organisation", async () => {
    await owner(async (c) => {
      expect(
        (
          await rows(
            c,
            "SELECT app.family_can_see($1, 'daily_updates', NULL, now() - interval '1 day') AS s",
            [a.personAda],
          )
        )[0]?.s,
      ).toBe(false);
    });
    await family(async (c) => {
      expect(
        (
          await rows(
            c,
            "SELECT app.family_can_see($1, 'daily_updates', NULL, now() - interval '1 day') AS s",
            [a.personAda],
          )
        )[0]?.s,
      ).toBe(false);
    }, TENANT_B);
    const [fn] = await db
      .pool("harbour_owner")
      .query(
        "SELECT prosecdef, proconfig, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname = 'family_can_see'",
      )
      .then((r) => r.rows);
    expect(fn).toMatchObject({ prosecdef: true, owner: "harbour_family_reader" });
    expect(fn?.proconfig).toContain("search_path=pg_catalog, public");
  });
});

describe("hazard HZ-022 the family feed opens only under a sharing decision", () => {
  it("is empty without a decision, and the family session reaches no staff table", async () => {
    await family(async (c) => {
      expect(await rows(c, "SELECT id FROM feed_item")).toEqual([]);
      const tables = await rows(
        c,
        `SELECT DISTINCT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'person_id'
           AND table_name NOT IN ('family_portal_user') ORDER BY table_name`,
      );
      expect(tables.length).toBeGreaterThan(20);
      for (const { table_name } of tables) {
        const found = await rows(c, `SELECT count(*)::int AS n FROM public.${table_name}`);
        expect(found[0]?.n, table_name).toBe(0);
      }
      // Its own links only.
      expect((await rows(c, "SELECT contact_id FROM family_portal_user")).length).toBe(2);
    });
  });

  it("opens an update for the family member's own decision, never another person's", async () => {
    await owner((c) => insertDecision(c, a.personAda, {}, Date.now()));
    await owner((c) => insertDecision(c, a.personBen, { contact: () => finn }, Date.now()));
    await family(async (c) => {
      expect((await rows(c, "SELECT id FROM feed_item")).map((r) => r.id)).toEqual([itemAda]);
      expect(await rows(c, "SELECT id FROM sharing_decision")).toEqual([]);
      expect(await rows(c, "SELECT id FROM person")).toEqual([]);
    });
    // The same member in another organisation sees nothing.
    await family(
      async (c) => expect(await rows(c, "SELECT id FROM feed_item")).toEqual([]),
      TENANT_B,
    );
    // Staff follow the person scope.
    await manager(async (c) => expect((await rows(c, "SELECT id FROM feed_item")).length).toBe(2));
    expect(itemBen).toBeTruthy();
  });

  it("writes nothing but its own views, and an update taken down shows only if it was seen", async () => {
    await expect(
      family((c) =>
        c.query(
          `INSERT INTO feed_item (person_id, kind, section, source_kind, source_id, occurred_at, text)
           VALUES ($1, 'shared_note', 'daily_updates', 'shared_note', app.uuid_v7(), now(), 'x')`,
          [a.personAda],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(family((c) => insertDecision(c, a.personAda, {}, Date.now()))).rejects.toThrow(
      /row-level security/,
    );
    const [decision] = await owner((c) =>
      rows(c, "SELECT id FROM sharing_decision WHERE person_id = $1", [a.personAda]),
    );
    const view = (c: pg.PoolClient, contact: string) =>
      c.query(
        `INSERT INTO feed_view (person_id, feed_item_id, contact_id, sharing_decision_id, section,
           person_status, capacity_for_sharing)
         VALUES ($1, $2, $3, $4, 'x', 'active', 'presumed')`,
        [a.personAda, itemAda, contact, decision?.id],
      );
    await expect(manager((c) => view(c, eve))).rejects.toThrow(/row-level security/);
    await expect(family((c) => view(c, finn))).rejects.toThrow(/row-level security|foreign key/);
    await family((c) => view(c, eve));
    await manager((c) =>
      c.query(
        "INSERT INTO feed_item_withdrawal (person_id, feed_item_id, reason) VALUES ($1, $2, 'published_in_error')",
        [a.personAda, itemAda],
      ),
    );
    await family(async (c) => {
      expect((await rows(c, "SELECT id FROM feed_item")).length).toBe(1);
      expect((await rows(c, "SELECT section FROM feed_view"))[0]?.section).toBe("daily_updates");
    });
    // An update taken down before it was seen is gone.
    await manager(async (c) => {
      const [unseen] = await rows(
        c,
        `INSERT INTO feed_item (person_id, kind, section, source_kind, source_id, occurred_at, text)
         VALUES ($1, 'shared_note', 'daily_updates', 'shared_note', app.uuid_v7(),
           now() - interval '2 hours', 'Painted a picture.') RETURNING id`,
        [a.personAda],
      );
      await c.query(
        "INSERT INTO feed_item_withdrawal (person_id, feed_item_id, reason) VALUES ($1, $2, 'person_asked')",
        [a.personAda, unseen?.id],
      );
    });
    await family(async (c) =>
      expect((await rows(c, "SELECT id FROM feed_item")).map((r) => r.id)).toEqual([itemAda]),
    );
    await expect(
      manager((c) => c.query("UPDATE feed_item SET text = 'changed' WHERE id = $1", [itemAda])),
    ).rejects.toThrow(/permission denied|append-only|not allowed/);
  });

  it("refuses a person assignment for a portal account, and a portal link for an assigned one", async () => {
    await expect(
      owner((c) =>
        c.query("INSERT INTO person_assignment (tenant_user_id, person_id) VALUES ($1, $2)", [
          FAMILY,
          a.personAda,
        ]),
      ),
    ).rejects.toThrow(/no person assignment/);
    await expect(
      manager((c) =>
        c.query(
          "INSERT INTO family_portal_user (tenant_user_id, person_id, contact_id) VALUES ($1, $2, $3)",
          [a.carer, a.personAda, eve],
        ),
      ),
    ).rejects.toThrow(/no person assignment/);
  });

  it("refuses updates that should never exist", async () => {
    const bad = (kind: string, section: string, extra = "NULL") =>
      owner((c) =>
        c.query(
          `INSERT INTO feed_item (person_id, kind, section, care_plan_domain, source_kind, source_id,
             occurred_at, text) VALUES ($1, $2, $3, ${extra}, 'activity', app.uuid_v7(), now(), 'Text')`,
          [a.personAda, kind, section],
        ),
      );
    await expect(bad("care_plan_update", "care_plan")).rejects.toThrow(/care_plan_domain/);
    await expect(bad("activity", "photos")).rejects.toThrow(/feed_item_section/);
    await expect(bad("photo", "photos")).rejects.toThrow(/feed_item_photo/);
  });
});

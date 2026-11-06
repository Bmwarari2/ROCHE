import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The controlled drugs register in the database (Phase 2 slice 34; MEDS-005; migration 0128):
 * another tenant sees nothing and every table follows the person's scope; entries, pages and
 * stock checks are never edited; the database checks the running balance, the order and the
 * place on the page; a correction names an entry on its own page; a witness is a second person
 * whose signed assertion matches what is recorded and is used once; destruction is always
 * witnessed; a stock check counts against the page; an administration and its entry name each
 * other.
 *
 * Fixture: Ada and Ben live at North (the care worker is assigned to Ada only), Cara at South.
 */

let db: TestDatabase;
const a = ids.a;
const ADA_PAGE = "0193a000-0000-7000-8000-00000000c101";
const BEN_PAGE = "0193a000-0000-7000-8000-00000000c102";
const CARA_PAGE = "0193a000-0000-7000-8000-00000000c103";
const MORPHINE = "90000081000001109";

const app = () => db.pool("harbour_app");
const manager = ctx(TENANT_A, a.manager, "tenant");
const carer = ctx(TENANT_A, a.carer, "assigned");
const north = ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);

async function refused(
  context: ReturnType<typeof ctx>,
  fn: (c: pg.PoolClient) => Promise<unknown>,
) {
  return inContext(app(), context, async (c) => {
    await c.query("SAVEPOINT s");
    try {
      await fn(c);
      return null;
    } catch (error) {
      await c.query("ROLLBACK TO SAVEPOINT s");
      return (error as { code?: string }).code ?? "error";
    }
  });
}

async function assertion(
  c: pg.PoolClient,
  personId: string,
  pageId: string,
  movement: string,
  quantity: number,
  witness: string = a.carer,
  recorder: string = a.manager,
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO controlled_drug_witness_assertion (person_id, page_id, movement, quantity,
       witness_id, recorder_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '10 minutes') RETURNING id::text`,
    [personId, pageId, movement, quantity, witness, recorder],
  );
  return (rows[0] as { id: string }).id;
}

/** An entry; witnessed by `witness` through a fresh assertion unless a reason for none is given. */
async function entry(
  c: pg.PoolClient,
  e: {
    personId: string;
    pageId: string;
    seq: number;
    movement: string;
    quantity: number;
    balance: number;
    witness?: string | null;
    noWitness?: string;
    occurredAt?: string;
    correctsId?: string;
    corrects?: string;
    reason?: string;
    assertionId?: string;
  },
) {
  const witness = e.noWitness ? null : (e.witness ?? a.carer);
  const assertionId =
    e.assertionId ??
    (witness ? await assertion(c, e.personId, e.pageId, e.movement, e.quantity, witness) : null);
  const id = randomUUID();
  await c.query(
    `INSERT INTO controlled_drug_entry (id, person_id, page_id, seq, movement, quantity,
       balance_after, corrects_id, corrects, reason, occurred_at, recorded_by, witness_id,
       witness_assertion_id, no_witness_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now()), $12, $13,
       $14, $15)`,
    [
      id,
      e.personId,
      e.pageId,
      e.seq,
      e.movement,
      e.quantity,
      e.balance,
      e.correctsId ?? null,
      e.corrects ?? null,
      e.reason ?? null,
      e.occurredAt ?? null,
      a.manager,
      witness,
      assertionId,
      e.noWitness ?? null,
    ],
  );
  return id;
}

let firstAda = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(app(), manager, async (c) => {
    for (const [id, personId] of [
      [ADA_PAGE, a.personAda],
      [BEN_PAGE, a.personBen],
      [CARA_PAGE, a.personCara],
    ] as const) {
      await c.query(
        `INSERT INTO controlled_drug_page (id, person_id, vmp_id, product_name, unit_code,
           unit_name, opened_by)
         VALUES ($1, $2, $3, 'Morphine sulfate 10mg tablets', '428673006', 'tablet', $4)`,
        [id, personId, MORPHINE, a.manager],
      );
    }
    firstAda = await entry(c, {
      personId: a.personAda,
      pageId: ADA_PAGE,
      seq: 1,
      movement: "receipt",
      quantity: 28,
      balance: 28,
      occurredAt: "2026-11-01T09:00:00Z",
    });
    await entry(c, {
      personId: a.personBen,
      pageId: BEN_PAGE,
      seq: 1,
      movement: "receipt",
      quantity: 10,
      balance: 10,
    });
    await entry(c, {
      personId: a.personCara,
      pageId: CARA_PAGE,
      seq: 1,
      movement: "receipt",
      quantity: 10,
      balance: 10,
    });
  });
});

afterAll(async () => {
  await db?.drop();
});

const visible = (context: ReturnType<typeof ctx>, table: string) =>
  inContext(app(), context, async (c) =>
    (await c.query<{ page_id: string }>(`SELECT DISTINCT page_id::text FROM ${table}`)).rows
      .map((r) => r.page_id)
      .sort(),
  );

describe("hazard HZ-011 the register is isolated by tenant and follows the person's scope", () => {
  it("shows another tenant nothing, and each member only the people in their scope", async () => {
    for (const table of [
      "controlled_drug_entry",
      "controlled_drug_witness_assertion",
      "controlled_drug_stock_check",
    ]) {
      expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"), table)).toEqual([]);
    }
    expect(await visible(manager, "controlled_drug_entry")).toEqual(
      [ADA_PAGE, BEN_PAGE, CARA_PAGE].sort(),
    );
    expect(await visible(carer, "controlled_drug_entry")).toEqual([ADA_PAGE]);
    expect(await visible(north, "controlled_drug_entry")).toEqual([ADA_PAGE, BEN_PAGE].sort());
  });

  it("refuses an entry for a person outside the member's scope", async () => {
    expect(
      await refused(carer, (c) =>
        entry(c, {
          personId: a.personBen,
          pageId: BEN_PAGE,
          seq: 2,
          movement: "receipt",
          quantity: 1,
          balance: 11,
          noWitness: "Lone worker",
        }),
      ),
    ).not.toBeNull();
  });
});

describe("hazard HZ-115 the running balance is checked by the database", () => {
  it("takes the next entry whose balance follows, and refuses a wrong balance, place or order", async () => {
    const take = (e: Partial<Parameters<typeof entry>[1]>) =>
      refused(manager, (c) =>
        entry(c, {
          personId: a.personAda,
          pageId: ADA_PAGE,
          seq: 2,
          movement: "administration",
          quantity: 1,
          balance: 27,
          occurredAt: "2026-11-01T10:00:00Z",
          ...e,
        }),
      );
    expect(await take({ balance: 26 })).toBe("23514");
    expect(await take({ seq: 3 })).toBe("23514");
    expect(await take({ occurredAt: "2026-11-01T08:00:00Z" })).toBe("23514");
    expect(await take({ quantity: 29, balance: -1 })).toBe("23514");
    expect(await take({})).toBeNull();
    // A second entry in the same place meets the unique key.
    expect(await take({})).not.toBeNull();
  });

  it("corrects only an entry on its own page, with a reason and what it corrects", async () => {
    const correct = (e: Partial<Parameters<typeof entry>[1]>) =>
      refused(manager, (c) =>
        entry(c, {
          personId: a.personAda,
          pageId: ADA_PAGE,
          seq: 3,
          movement: "correction",
          quantity: -2,
          balance: 25,
          correctsId: firstAda,
          corrects: "quantity",
          reason: "The delivery was 26, not 28",
          occurredAt: "2026-11-01T11:00:00Z",
          ...e,
        }),
      );
    expect(await correct({ reason: " " })).toBe("23514");
    expect(await correct({ corrects: "detail" })).toBe("23514");
    let benEntry = "";
    await inContext(app(), manager, async (c) => {
      benEntry = (
        await c.query<{ id: string }>(
          "SELECT id::text FROM controlled_drug_entry WHERE page_id = $1",
          [BEN_PAGE],
        )
      ).rows[0]?.id as string;
    });
    expect(await correct({ correctsId: benEntry })).toBe("23503");
    expect(await correct({})).toBeNull();
  });

  it("never updates or deletes an entry, a page or a stock check for the application", async () => {
    expect(
      await refused(manager, (c) =>
        c.query("UPDATE controlled_drug_entry SET quantity = 1 WHERE id = $1", [firstAda]),
      ),
    ).toBe("42501");
    expect(
      await refused(manager, (c) =>
        c.query("DELETE FROM controlled_drug_page WHERE id = $1", [ADA_PAGE]),
      ),
    ).toBe("42501");
  });
});

describe("hazard HZ-116 a second signature is a second person who signed for what is recorded", () => {
  it("refuses the recorder as witness, a mismatched or reused assertion, and an unwitnessed destruction", async () => {
    const next = async (c: pg.PoolClient) =>
      (
        await c.query<{ seq: number; balance: string }>(
          "SELECT seq, balance_after AS balance FROM controlled_drug_entry WHERE page_id = $1 ORDER BY seq DESC LIMIT 1",
          [CARA_PAGE],
        )
      ).rows[0] as { seq: number; balance: string };
    const destroy = (e: Partial<Parameters<typeof entry>[1]>) =>
      refused(manager, async (c) => {
        const last = await next(c);
        return entry(c, {
          personId: a.personCara,
          pageId: CARA_PAGE,
          seq: last.seq + 1,
          movement: "destruction",
          quantity: 1,
          balance: Number(last.balance) - 1,
          ...e,
        });
      });
    expect(await destroy({ witness: a.manager })).not.toBeNull();
    // A signature names the recorder the witness watched: nobody else's entry may use it.
    let forOther = "";
    await inContext(app(), manager, async (c) => {
      forOther = await assertion(
        c,
        a.personCara,
        CARA_PAGE,
        "destruction",
        1,
        a.carer,
        a.northManager,
      );
    });
    expect(await destroy({ assertionId: forOther })).toBe("23514");
    expect(await destroy({ noWitness: "Nobody else on shift" })).toBe("23514");
    let wrong = "";
    await inContext(app(), manager, async (c) => {
      wrong = await assertion(c, a.personCara, CARA_PAGE, "destruction", 2);
    });
    expect(await destroy({ assertionId: wrong })).toBe("23514");
    let used = "";
    await inContext(app(), manager, async (c) => {
      used = await assertion(c, a.personCara, CARA_PAGE, "destruction", 1);
    });
    expect(await destroy({ assertionId: used })).toBeNull();
    expect(await destroy({ assertionId: used })).not.toBeNull();
  });

  it("lets an assertion change only by being used, once", async () => {
    let id = "";
    await inContext(app(), manager, async (c) => {
      id = await assertion(c, a.personCara, CARA_PAGE, "receipt", 5);
    });
    expect(
      await refused(manager, (c) =>
        c.query("UPDATE controlled_drug_witness_assertion SET quantity = 6 WHERE id = $1", [id]),
      ),
    ).toBe("23514");
    expect(
      await refused(manager, (c) =>
        c.query("DELETE FROM controlled_drug_witness_assertion WHERE id = $1", [id]),
      ),
    ).toBe("42501");
  });
});

describe("hazard HZ-115 a stock check counts against the page as it stands", () => {
  it("refuses an expected balance other than the page's, and a difference with no reason", async () => {
    const check = (counted: number, expected: number, reason: string | null) =>
      refused(manager, async (c) => {
        const witness = await assertion(c, a.personBen, BEN_PAGE, "stock_check", counted);
        await c.query(
          `INSERT INTO controlled_drug_stock_check (person_id, page_id, counted, expected,
             difference, reason, checked_by, witness_id, witness_assertion_id)
           VALUES ($1, $2, $3, $4, $3::numeric - $4::numeric, $5, $6, $7, $8)`,
          [a.personBen, BEN_PAGE, counted, expected, reason, a.manager, a.carer, witness],
        );
      });
    expect(await check(10, 9, null)).toBe("23514");
    expect(await check(9, 10, null)).toBe("23514");
    expect(await check(9, 10, "One tablet unaccounted for")).toBeNull();
    expect(await check(10, 10, null)).toBeNull();
  });
});

describe("hazard HZ-004 an administration and its register entry name each other", () => {
  it("refuses an administration entry the administration does not name", async () => {
    let administration = "";
    await inContext(app(), manager, async (c) => {
      const med = randomUUID();
      await c.query(
        `INSERT INTO medication (id, person_id, medicine_id, version, origin, vmp_id, product_name,
           route_code, route_name, directions, pattern_kind, prescriber, starts_at, source_kind,
           source_reference, transcribed_by, transcribed_at, cd_schedule)
         VALUES ($1, $2, $1, 1, 'transcribed', $3, 'Morphine sulfate 10mg tablets', '26643006',
           'Oral', 'regular', 'every_day', 'Dr A Example', now(), 'prescription', 'Prescription',
           $4, now(), '2')`,
        [med, a.personBen, MORPHINE, a.manager],
      );
      administration = randomUUID();
      await c.query(
        `INSERT INTO medication_administration (id, person_id, medication_id, outcome, quantity,
           unit_code, given_at, recorded_by, cd_entry_id)
         VALUES ($1, $2, $3, 'given', 1, '428673006', now(), $4, gen_random_uuid())`,
        [administration, a.personBen, med, a.manager],
      );
    });
    expect(
      await refused(manager, async (c) => {
        const last = (
          await c.query<{ seq: number; balance: string }>(
            "SELECT seq, balance_after AS balance FROM controlled_drug_entry WHERE page_id = $1 ORDER BY seq DESC LIMIT 1",
            [BEN_PAGE],
          )
        ).rows[0] as { seq: number; balance: string };
        await c.query(
          `INSERT INTO controlled_drug_entry (person_id, page_id, seq, movement, quantity,
             balance_after, occurred_at, recorded_by, no_witness_reason, administration_id)
           VALUES ($1, $2, $3, 'administration', 1, $4, now(), $5, 'Lone worker', $6)`,
          [
            a.personBen,
            BEN_PAGE,
            last.seq + 1,
            Number(last.balance) - 1,
            a.manager,
            administration,
          ],
        );
      }),
    ).toBe("23514");
  });
});

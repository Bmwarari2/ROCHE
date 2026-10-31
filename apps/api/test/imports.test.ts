import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { SYNC_TOKEN_TTL_SECONDS } from "@harbour/sync/streams";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { expireImportsJob } from "../src/jobs/tasks";
import { createLogger, loggableError } from "../src/logger";
import { ImportWriteFailed, writingImported } from "../src/services/platform-imports";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The import wizard over HTTP (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130, HZ-007,
 * HZ-072, HZ-011). Every person here is invented ("Example" family names, 999-range NHS numbers).
 */

let h: Harness;

/** A home-scoped role holding both import permissions, for the manager (rule 18). */
const HOME_IMPORTER_ROLE = "0194d000-0000-7000-8000-00000000a601";
/** An organisation of the demo owner's with sample data loaded (HZ-072). */
const SAMPLE = {
  tenantId: "0194f100-0000-7000-8000-000000000001",
  locationId: "0194f100-0000-7000-8000-000000000101",
  ownerId: "0194f100-0000-7000-8000-000000000301",
  roleId: "0194f100-0000-7000-8000-000000000401",
};

/** Runs SQL as the owner role in one organisation's view, committed. */
async function ownerSql<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
  tenant: string = DEMO.tenantId,
) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenant],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let nhsSeed = 0;
/** A 999-range NHS number with a valid check digit, distinct each call, in no fixture. */
function nextNhs(): string {
  for (;;) {
    nhsSeed += 1;
    const body = `999${String(7300000 + nhsSeed).slice(-6)}`;
    const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
    const check = 11 - (sum % 11);
    if (check === 10) continue;
    return `${body}${check === 11 ? 0 : check}`;
  }
}

type Json = Record<string, unknown>;
const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const send = (
  path: string,
  method: string,
  body?: unknown,
  who = "owner",
  tenant: string = DEMO.tenantId,
) => h.request(path, { method, body, ...as(who, tenant) });
const json = async (res: Response) => (await res.json()) as Json;

/** Uploads CSV text as the owner (or `who`) and returns the response. */
const upload = (csv: string, extra: Json = {}, who = "owner", tenant: string = DEMO.tenantId) =>
  send(
    "/v1/imports",
    "POST",
    { recordType: "people", locationId: DEMO.locationId, csv, ...extra },
    who,
    tenant,
  );

/** Uploads and dry-runs a file as the owner: the batch id and the report. */
async function stagedAndChecked(csv: string, extra: Json = {}) {
  const res = await upload(csv, extra);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  const batch = (await res.json()) as { id: string };
  const dry = await send(`/v1/imports/${batch.id}/dry-run`, "POST");
  expect(dry.status).toBe(200);
  return { id: batch.id, report: (await dry.json()) as Json };
}

const HEADER = "given_name,family_name,date_of_birth,nhs_number,local_identifier,allergy_status";
/**
 * One person's row: a family name of their own ("Example-Ida"), so rows that share the date of
 * birth are not possible duplicates of each other unless a test means them to be.
 */
const line = (given: string, nhs: string, extra = "") =>
  `${given},Example-${given},06/05/1930,${nhs},${extra}`;

const stagedRowCount = async (batchId: string) =>
  Number(
    (
      await ownerSql<{ n: number }>(
        "SELECT count(*)::int AS n FROM import_row WHERE batch_id = $1",
        [batchId],
      )
    )[0]?.n,
  );

beforeAll(async () => {
  h = await createHarness();
  // The manager is given both import permissions at their own home only (a tenant may do this).
  await ownerSql(
    `INSERT INTO role (id, key, name, scope_kind, permissions)
     VALUES ($1, 'home_importer', 'Home importer', 'location',
             '{platform.import.run,people.person.create,people.person.read}')`,
    [HOME_IMPORTER_ROLE],
  );
  await ownerSql(
    "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
    [DEMO.users.manager.id, HOME_IMPORTER_ROLE, DEMO.locationId],
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-130 who may import (rule 18)", () => {
  it("refuses a member without the import permissions", async () => {
    const res = await upload(`${HEADER}\n${line("Ida", nextNhs())},unknown`, {}, "carer");
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("missing_permission");
  });

  it("hazard HZ-130 refuses a holder at one home with one answer, whatever the file holds", async () => {
    // A number on the record of someone at another home, and a number nobody has.
    const elsewhere = await upload(
      `${HEADER}\n${line("Gwen", "9990000077")},unknown`,
      {},
      "manager",
    );
    const unused = await upload(`${HEADER}\n${line("Ida", nextNhs())},unknown`, {}, "manager");
    const listed = await send("/v1/imports", "GET", undefined, "manager");
    const strip = async (res: Response) => {
      const { requestId: _ignored, ...rest } = await json(res);
      return { status: res.status, ...rest };
    };
    const first = await strip(elsewhere);
    expect(first).toMatchObject({ status: 403, code: "organisation_wide_required" });
    expect(await strip(unused)).toEqual(first);
    expect(await strip(listed)).toEqual(first);
    const audits = await ownerSql<{ outcome: string; reason: string }>(
      `SELECT outcome, reason FROM audit_event
        WHERE action = 'platform.import.uploaded' AND actor_tenant_user_id = $1`,
      [DEMO.users.manager.id],
    );
    expect(audits).toEqual([
      { outcome: "denied", reason: "organisation_wide_required" },
      { outcome: "denied", reason: "organisation_wide_required" },
    ]);
    // Nothing was staged for them.
    expect(
      await ownerSql("SELECT id FROM import_batch WHERE uploaded_by = $1", [DEMO.users.manager.id]),
    ).toEqual([]);
  });

  it("hazard HZ-011 another organisation's batch is not found, as one that does not exist", async () => {
    const [other] = await ownerSql<{ id: string }>(
      `INSERT INTO import_batch (record_type, location_id, row_count, expires_at, uploaded_by)
       VALUES ('people', $1, 1, now() + interval '1 day', $2) RETURNING id`,
      [OTHER.locationId, OTHER.managerId],
      OTHER.tenantId,
    );
    const missing = "0194d000-0000-7000-8000-0000000fffff";
    for (const id of [other?.id, missing]) {
      for (const [path, method, body] of [
        [`/v1/imports/${id}`, "GET", undefined],
        [`/v1/imports/${id}/dry-run`, "POST", undefined],
        [`/v1/imports/${id}/commit`, "POST", {}],
        [`/v1/imports/${id}/undo`, "POST", undefined],
        [`/v1/imports/${id}`, "DELETE", undefined],
      ] as const) {
        const res = await send(path, method, body);
        expect([path, method, res.status, (await json(res)).code]).toEqual([
          path,
          method,
          404,
          "not_found",
        ]);
      }
    }
    // And a location of another organisation is not one of this organisation's.
    const res = await send("/v1/imports", "POST", {
      recordType: "people",
      locationId: OTHER.locationId,
      csv: `${HEADER}\n${line("Ida", nextNhs())},unknown`,
    });
    expect(res.status).toBe(422);
  });
});

describe("hazard HZ-130 uploading names columns and rows by number, never by what they hold", () => {
  it("hazard HZ-130 refuses a file without a header row, naming columns by position", async () => {
    const res = await upload(
      "Ada,Example,06/05/1930,9990001502\nBo,Sample,01/01/1940,9990000034\n",
    );
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.code).toBe("columns_not_mapped");
    expect(String(body.detail)).toMatch(/Column 1 .*Column 2 .*Column 3 .*Column 4/);
    expect(JSON.stringify(body)).not.toMatch(/Ada|Example|Sample|\b9990001502\b/);
  });

  it.each([
    ["an unclosed quote", { csv: `${HEADER}\n"Ada,Example,06/05/1930,,R-1,unknown\n` }, /Row 1/],
    ["both CSV and rows", { csv: HEADER, rows: [] }, /one or the other/],
    [
      "a mapping value that is not a field key",
      { csv: HEADER, mapping: { "Ada Example": 7 } },
      /mapping/,
    ],
    ["a value that is not text", { rows: [{ given_name: "Ada", family_name: 1930 }] }, /Row 1/],
    ["a file with no rows", { csv: `${HEADER}\n` }, /no rows/],
  ])("refuses %s without echoing a value", async (_name, extra, detail) => {
    const res = await send("/v1/imports", "POST", {
      recordType: "people",
      locationId: DEMO.locationId,
      ...extra,
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(String(body.detail)).toMatch(detail);
    expect(JSON.stringify(body)).not.toMatch(/Ada|Example/);
  });

  it("takes JSON rows and a mapping that leaves a column out, staging only matched cells", async () => {
    const nhs = nextNhs();
    const res = await upload("", {
      csv: undefined,
      rows: [{ Forename: "Ida", Surname: "Example", DOB: "06/05/1930", "NHS No": nhs, Room: "12" }],
      mapping: {
        Forename: "given_name",
        Surname: "family_name",
        DOB: "date_of_birth",
        "NHS No": "nhs_number",
        Room: null,
      },
    });
    expect(res.status).toBe(201);
    const batch = (await res.json()) as { id: string; rows: number; status: string };
    expect(batch).toMatchObject({ rows: 1, status: "staged" });
    const [row] = await ownerSql<{ cells: Json }>(
      "SELECT cells FROM import_row WHERE batch_id = $1",
      [batch.id],
    );
    expect(row?.cells).toEqual({
      given_name: "Ida",
      family_name: "Example",
      date_of_birth: "06/05/1930",
      nhs_number: nhs,
    });
    expect((await send(`/v1/imports/${batch.id}`, "DELETE")).status).toBe(200);
  });
});

describe("hazard HZ-130 dry run, commit and undo (rules 21 to 24)", () => {
  it("hazard HZ-130 reports a number already in Harbour, at another home too, and treats another organisation's as new", async () => {
    const fresh = nextNhs();
    const { id, report } = await stagedAndChecked(
      [
        HEADER,
        `${line("Ida", fresh)},no_known_allergies`,
        // Gwen Outofscope's number, at Harbour Lodge: the owner can see her, so it is said.
        `${line("Gwen", "9990000077")},unknown`,
        // Hal Elsewhere's number, in another organisation: never read, so a new person.
        `${line("Hal", "9990000085")},has_allergies`,
        `${line("Jo", "", "R-1")},`,
      ].join("\n"),
    );
    expect(report).toMatchObject({
      rows: 4,
      validRows: 3,
      errorCount: 1,
      warningCount: 0,
      mayCommit: false,
      needsAcknowledgement: false,
      // The owner can see Gwen's record, so the error names it (rule 18: nothing new to them).
      errors: [
        { row: 2, column: "nhs_number", code: "already_in_harbour", personId: LODGE.personId },
      ],
      allergyStatusNotStatedRows: [2, 4],
      noKnownAllergiesStatedRows: [1],
      hasAllergiesStatedRows: [3],
    });
    expect((report.whatHappens as string[]).join(" ")).toMatch(/Nothing can be committed/);
    expect(JSON.stringify(report)).not.toMatch(/9990000077|9990000085|Gwen|Outofscope|Lodge/);
    // Nothing commits with an error, and nothing was created.
    const refused = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect(refused.status).toBe(409);
    expect((await json(refused)).code).toBe("has_errors");
    expect(await ownerSql("SELECT id FROM person WHERE nhs_number = $1", [fresh])).toEqual([]);
    expect((await send(`/v1/imports/${id}`, "DELETE")).status).toBe(200);
  });

  it("hazard HZ-130 commits a clean batch whole, once, and undoes it once", async () => {
    const numbers = [nextNhs(), "9990000085"];
    const csv = [
      HEADER,
      `${line("Ida", numbers[0] ?? "")},no_known_allergies`,
      `${line("Hal", numbers[1] ?? "")},`,
      `${line("Jo", "", "R-2")},has_allergies`,
    ].join("\n");
    const { id, report } = await stagedAndChecked(csv);
    expect(report).toMatchObject({
      errorCount: 0,
      warningCount: 0,
      mayCommit: true,
      allergyStatusNotStatedRows: [2],
      noKnownAllergiesStatedRows: [1],
      hasAllergiesStatedRows: [3],
    });
    const words = (report.whatHappens as string[]).join(" ");
    expect(words).toMatch(/creates 3 people/);
    expect(words).toMatch(/allergy status is imported as not recorded/);
    expect(words).toMatch(/Allergies themselves are not imported/);
    expect(words).toMatch(/no photo, room or placement/);

    // Commit and undo need a fresh second factor.
    const tokenSession = (h.tokens.owner ?? "").split(".")[0] ?? "";
    await ageSession(h.db.pool("harbour_auth"), tokenSession, 3600);
    const stale = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect([stale.status, (await json(stale)).code]).toEqual([403, "step_up_required"]);
    await ageSession(h.db.pool("harbour_auth"), tokenSession, 0);

    const committed = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect(committed.status).toBe(200);
    const result = (await committed.json()) as {
      records: number;
      replayed: boolean;
      undoAvailable: boolean;
      undoClosesAt: string;
      allergyStatusToConfirm: { personId: string; taskId: string; stated: string }[];
    };
    expect(result).toMatchObject({ records: 3, replayed: false, undoAvailable: true });
    expect(typeof result.undoClosesAt).toBe("string");
    const people = await ownerSql<{
      id: string;
      given_name: string;
      status: string;
      location_id: string;
      allergy_status: string;
      allergy_status_confirmed_by: string | null;
      import_batch_id: string;
    }>(
      `SELECT id, given_name, status, location_id, allergy_status, allergy_status_confirmed_by,
              import_batch_id
         FROM person
        WHERE nhs_number = ANY ($1) OR local_identifier = 'R-2' ORDER BY given_name`,
      [numbers],
    );
    // HZ-007: whatever the file stated, every status is not recorded, confirmed by no one, until
    // staff check it; the people the file stated a status for are returned to check first.
    expect(
      people.map((p) => [p.status, p.location_id, p.allergy_status, p.allergy_status_confirmed_by]),
    ).toEqual([
      ["active", DEMO.locationId, "unknown", null],
      ["active", DEMO.locationId, "unknown", null],
      ["active", DEMO.locationId, "unknown", null],
    ]);
    expect(people.every((p) => p.import_batch_id === id)).toBe(true);
    // HZ-007 (#150 clinical M-A): what the file said is kept, on a task for each person whose
    // status it stated, paired by NHS number (Ida) or local identifier (Jo), not by row order.
    const byName = new Map(people.map((p) => [p.given_name, p.id]));
    const checks = await ownerSql<{
      id: string;
      person_id: string;
      kind: string;
      required_permission: string;
      assignee_role_key: string;
      priority: string;
      status: string;
      location_id: string;
      details: Json;
    }>(
      `SELECT id, person_id, kind, required_permission, assignee_role_key, priority, status,
              location_id, details
         FROM task WHERE source_type = 'import_batch' AND source_id = $1`,
      [id],
    );
    const checkFor = (name: string) => checks.find((t) => t.person_id === byName.get(name));
    expect(checks).toHaveLength(2);
    expect(checkFor("Ida")).toMatchObject({
      kind: "people.allergy_status_check",
      required_permission: "people.person.update",
      assignee_role_key: "registered_manager",
      priority: "routine",
      status: "open",
      location_id: DEMO.locationId,
      details: { importedAllergyStatus: "no_known_allergies" },
    });
    expect(checkFor("Jo")).toMatchObject({
      priority: "urgent",
      details: { importedAllergyStatus: "has_allergies" },
    });
    expect(checkFor("Hal")).toBeUndefined();
    const toConfirm = [
      { personId: byName.get("Ida"), taskId: checkFor("Ida")?.id, stated: "no_known_allergies" },
      { personId: byName.get("Jo"), taskId: checkFor("Jo")?.id, stated: "has_allergies" },
    ].sort((a, b) => String(a.personId).localeCompare(String(b.personId)));
    expect(result.allergyStatusToConfirm).toEqual(toConfirm);
    // Another organisation's person with the same number is untouched and still its own.
    expect(
      await ownerSql("SELECT id FROM person WHERE nhs_number = '9990000085'", [], OTHER.tenantId),
    ).toEqual([{ id: OTHER.personId }]);
    expect(await stagedRowCount(id)).toBe(0);

    // Again: the same commit and checks, nobody created twice.
    const again = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect(await json(again)).toMatchObject({
      records: 3,
      replayed: true,
      undoAvailable: true,
      allergyStatusToConfirm: toConfirm,
    });
    const count = await ownerSql<{ n: number }>(
      "SELECT count(*)::int AS n FROM person WHERE nhs_number = ANY ($1) OR local_identifier = 'R-2'",
      [numbers],
    );
    expect(count[0]?.n).toBe(3);
    const shown = await json(await send(`/v1/imports/${id}`, "GET"));
    expect(shown).toMatchObject({
      status: "committed",
      records: 3,
      undoAvailable: true,
      undoClosesAt: result.undoClosesAt,
    });

    // Undo removes them and their open checks, once; the same file may then be imported afresh.
    const undone = await send(`/v1/imports/${id}/undo`, "POST");
    expect(undone.status).toBe(200);
    expect(await json(undone)).toMatchObject({ batchId: id, records: 3 });
    expect(
      await ownerSql("SELECT id FROM person WHERE id = ANY ($1)", [people.map((p) => p.id)]),
    ).toEqual([]);
    expect(
      await ownerSql("SELECT id FROM task WHERE source_type = 'import_batch' AND source_id = $1", [
        id,
      ]),
    ).toEqual([]);
    expect(await json(await send(`/v1/imports/${id}`, "GET"))).toMatchObject({
      status: "undone",
      undoAvailable: false,
      undoClosesAt: null,
    });
    const twice = await send(`/v1/imports/${id}/undo`, "POST");
    expect([twice.status, (await json(twice)).code]).toEqual([409, "already_undone"]);
    const retry = await stagedAndChecked(csv);
    expect(retry.report).toMatchObject({ errorCount: 0, mayCommit: true });
    expect((await send(`/v1/imports/${retry.id}`, "DELETE")).status).toBe(200);
  });

  it("hazard HZ-130 refuses an undo once a person has been changed or had a record made about them", async () => {
    const changed = await stagedAndChecked(
      `${HEADER}\n${line("Ida", nextNhs())},unknown\n${line("Bo", nextNhs())},unknown`,
    );
    expect((await send(`/v1/imports/${changed.id}/commit`, "POST", {})).status).toBe(200);
    const [commit] = await ownerSql<{ record_ids: string[] }>(
      "SELECT record_ids FROM import_commit WHERE batch_id = $1",
      [changed.id],
    );
    await ownerSql("UPDATE person SET preferred_name = 'Id' WHERE id = $1", [
      commit?.record_ids[0],
    ]);
    const refused = await send(`/v1/imports/${changed.id}/undo`, "POST");
    expect([refused.status, (await json(refused)).code]).toEqual([409, "changed_since"]);

    const referenced = await stagedAndChecked(`${HEADER}\n${line("Ida", nextNhs())},has_allergies`);
    expect((await send(`/v1/imports/${referenced.id}/commit`, "POST", {})).status).toBe(200);
    const [other] = await ownerSql<{ record_ids: string[] }>(
      "SELECT record_ids FROM import_commit WHERE batch_id = $1",
      [referenced.id],
    );
    await ownerSql(
      "INSERT INTO allergy (person_id, substance, severity) VALUES ($1, 'Latex', 'mild')",
      [other?.record_ids[0]],
    );
    const refusedAgain = await send(`/v1/imports/${referenced.id}/undo`, "POST");
    expect([refusedAgain.status, (await json(refusedAgain)).code]).toEqual([
      409,
      "referenced_since",
    ]);
    expect(
      await ownerSql("SELECT id FROM person WHERE id = ANY ($1)", [other?.record_ids]),
    ).toHaveLength(1);
    const audits = await ownerSql<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE action = 'platform.import.undone' AND outcome = 'denied' ORDER BY seq",
    );
    expect(audits.map((a) => a.reason)).toEqual(
      expect.arrayContaining(["changed_since", "referenced_since"]),
    );
  });

  it("hazard HZ-130 needs exactly the possible duplicates seen acknowledged, each naming the record or row", async () => {
    const first = await stagedAndChecked(`${HEADER}\n${line("Nia", "", "R-30")},unknown`);
    expect((await send(`/v1/imports/${first.id}/commit`, "POST", {})).status).toBe(200);
    const [nia] = await ownerSql<{ id: string }>(
      "SELECT id FROM person WHERE local_identifier = 'R-30'",
    );
    // The same name and date of birth, written differently, with no NHS number: perhaps the same
    // person. A second row with the names the other way round is a possible duplicate of row 1.
    const second = await stagedAndChecked(
      [HEADER, `${line("NIA", "", "R-31")},unknown`, "Example-Nia,Nia,06/05/1930,,R-32,"].join(
        "\n",
      ),
    );
    expect(second.report).toMatchObject({
      errorCount: 0,
      mayCommit: false,
      needsAcknowledgement: true,
    });
    const warnings = second.report.warnings as {
      row: number;
      match: string;
      personId: string | null;
      otherRow: number | null;
    }[];
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 1, match: "same_name", personId: nia?.id }),
        expect.objectContaining({ row: 2, match: "names_swapped", otherRow: 1 }),
      ]),
    );
    // A pair of rows is warned of once, on the later row (#150 security M: bounded warnings).
    expect(warnings.filter((w) => w.otherRow != null)).toHaveLength(1);
    const keys = second.report.warningKeys as string[];
    expect(keys).toHaveLength(warnings.length);
    const refused = await send(`/v1/imports/${second.id}/commit`, "POST", {});
    expect([refused.status, (await json(refused)).code]).toEqual([
      409,
      "possible_duplicates_unacknowledged",
    ]);
    // One fewer than found, or one never shown, is refused too.
    for (const acknowledgedWarnings of [keys.slice(1), [...keys, "9:same_name:row-1"]]) {
      const partial = await send(`/v1/imports/${second.id}/commit`, "POST", {
        acknowledgedWarnings,
      });
      expect((await json(partial)).code).toBe("possible_duplicates_unacknowledged");
    }
    const accepted = await send(`/v1/imports/${second.id}/commit`, "POST", {
      acknowledgedWarnings: keys,
    });
    expect(accepted.status).toBe(200);
  });

  it("refuses to commit before a dry run, and to change a batch that is no longer staged", async () => {
    const res = await upload(`${HEADER}\n${line("Ida", nextNhs())},unknown`);
    const { id } = (await res.json()) as { id: string };
    const early = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect([early.status, (await json(early)).code]).toEqual([409, "dry_run_first"]);
    const discarded = await send(`/v1/imports/${id}`, "DELETE");
    expect(await json(discarded)).toMatchObject({ status: "discarded" });
    expect(await stagedRowCount(id)).toBe(0);
    for (const [path, method] of [
      [`/v1/imports/${id}`, "DELETE"],
      [`/v1/imports/${id}/dry-run`, "POST"],
    ] as const) {
      const again = await send(path, method);
      expect([again.status, (await json(again)).code]).toEqual([409, "not_staged"]);
    }
    const commit = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect([commit.status, (await json(commit)).code]).toEqual([409, "not_staged"]);
  });

  it("refuses 999-range test NHS numbers and 0000000000 where the organisation's people are real", async () => {
    const config = h.handle.services.config as { importTestNhsNumbers: boolean };
    config.importTestNhsNumbers = false;
    try {
      const { id, report } = await stagedAndChecked(
        `${HEADER}\n${line("Ida", nextNhs())},unknown\n${line("Bo", "0000000000")},unknown`,
      );
      expect(report).toMatchObject({ errorCount: 2, byCode: { test_nhs_number: 2 } });
      expect(JSON.stringify(report)).not.toMatch(/\b999\d{7}\b|0000000000/);
      expect((await send(`/v1/imports/${id}`, "DELETE")).status).toBe(200);
    } finally {
      config.importTestNhsNumbers = true;
    }
    expect(loadConfig({ NODE_ENV: "test" }).importTestNhsNumbers).toBe(true);
    expect(
      loadConfig({ NODE_ENV: "test", IMPORT_TEST_NHS_NUMBERS: "off" }).importTestNhsNumbers,
    ).toBe(false);
  });

  // Last in this block: the sync token it issues stays in the organisation's audit trail, so no
  // later undo here would be allowed.
  it("hazard HZ-130 refuses an undo once a phone may hold the imported people", async () => {
    const { id, report } = await stagedAndChecked(`${HEADER}\n${line("Ivy", nextNhs())},unknown`);
    expect(report).toMatchObject({ phonesInUse: false });
    const pending = await send(`/v1/imports/${id}/commit`, "POST", {});
    expect(await json(pending)).toMatchObject({ undoAvailable: true });
    // The manager's phone asks for a sync token carrying the home's people.
    const token = await h.request("/v1/sync/token", { method: "POST", ...as("manager") });
    expect(token.status).toBe(200);
    // #150 clinical M-C: the batch no longer offers an undo it would refuse.
    expect(await json(await send(`/v1/imports/${id}`, "GET"))).toMatchObject({
      status: "committed",
      undoAvailable: false,
      undoClosesAt: null,
    });
    const refused = await send(`/v1/imports/${id}/undo`, "POST");
    expect([refused.status, (await json(refused)).code]).toEqual([409, "sent_to_devices"]);
    expect(await ownerSql("SELECT id FROM person WHERE import_batch_id = $1", [id])).toHaveLength(
      1,
    );

    // #150 clinical M-B: with phones in use, the dry run says an import cannot be undone, and
    // the commit needs that accepted.
    const next = await stagedAndChecked(`${HEADER}\n${line("Wyn", nextNhs())},unknown`);
    expect(next.report).toMatchObject({ phonesInUse: true, mayCommit: true });
    expect((next.report.whatHappens as string[]).join(" ")).toMatch(
      /Phones are in use .*cannot be undone once it is committed.*Confirm you accept this/,
    );
    const unaccepted = await send(`/v1/imports/${next.id}/commit`, "POST", {});
    expect([unaccepted.status, (await json(unaccepted)).code]).toEqual([
      409,
      "no_undo_not_accepted",
    ]);
    expect(await ownerSql("SELECT id FROM person WHERE import_batch_id = $1", [next.id])).toEqual(
      [],
    );
    const accepted = await send(`/v1/imports/${next.id}/commit`, "POST", { acceptNoUndo: true });
    expect(accepted.status).toBe(200);
    expect(await json(accepted)).toMatchObject({ records: 1, replayed: false });
    const [committedAudit] = await ownerSql<{ scope: Json }>(
      "SELECT scope FROM audit_event WHERE action = 'platform.import.committed' AND resource_id = $1 AND outcome = 'success'",
      [next.id],
    );
    expect(committedAudit?.scope).toMatchObject({ records: 1, noUndoAccepted: true });
    // The database looks back one sync token's lifetime before the commit.
    const [fn] = await ownerSql<{ def: string }>(
      "SELECT pg_get_functiondef('app.undo_import_batch(uuid, text)'::regprocedure) AS def",
    );
    expect(fn?.def).toContain(`'${SYNC_TOKEN_TTL_SECONDS} seconds'`);
  });
});

describe("hazard HZ-130 an imported value never reaches a log", () => {
  it("hazard HZ-130 refuses a cell that cannot be stored at upload, by row and field, logging nothing personal", async () => {
    const logged: unknown[] = [];
    const logger = h.handle.services.logger;
    const spies = (["error", "warn", "info"] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never),
    );
    try {
      const nul = await upload(`${HEADER}\nAda,Exa\u0000mple,06/05/1930,9990001502,,unknown\n`);
      expect(nul.status).toBe(422);
      const body = await json(nul);
      expect(String(body.detail)).toMatch(/Row 1: Family name/);
      const surrogate = await send("/v1/imports", "POST", {
        recordType: "people",
        locationId: DEMO.locationId,
        rows: [{ given_name: "Ada\uD800", family_name: "Example", date_of_birth: "06/05/1930" }],
      });
      expect(surrogate.status).toBe(422);
      expect(String((await json(surrogate)).detail)).toMatch(/Row 1: Given name/);
      expect(JSON.stringify([body, logged])).not.toMatch(/Ada|Exa|mple|9990001502|1930/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("hazard HZ-130 rethrows a failed write of imported values as its database code alone", async () => {
    const failing = Object.assign(
      new Error('Failed query: insert into "person" ... params: Ada,Example,1930-05-06,9990001502'),
      { cause: Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" }) },
    );
    const thrown = await writingImported(() => Promise.reject(failing)).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ImportWriteFailed);
    expect((thrown as ImportWriteFailed).code).toBe("22P05");
    const asLogged = JSON.stringify({
      message: (thrown as Error).message,
      stack: (thrown as Error).stack,
      cause: (thrown as { cause?: unknown }).cause ?? null,
      loggable: loggableError(thrown),
    });
    expect(asLogged).not.toMatch(/Ada|Example|1930|9990001502/);
    expect(loggableError(thrown)).toMatchObject({ type: "ImportWriteFailed", code: "22P05" });
  });
});

describe("staged rows go when a batch expires (rule 25)", () => {
  it("expires a staged batch past its time as the system, deleting its rows, audited", async () => {
    // The organisation keeps staged rows for no time at all (a tenant override of the default).
    await ownerSql(
      `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
       VALUES ($1, 'import.staging_expiry_days', 0, 'days', 'all', '2000-01-01', 'test', 'tenant')`,
      [DEMO.tenantId],
    );
    try {
      const res = await upload(`${HEADER}\n${line("Ida", nextNhs())},unknown`);
      const { id } = (await res.json()) as { id: string };
      expect(await stagedRowCount(id)).toBe(1);
      // Past its time, a batch is never committed, even before the sweep reaches it (#150 L2).
      expect((await send(`/v1/imports/${id}/dry-run`, "POST")).status).toBe(200);
      const late = await send(`/v1/imports/${id}/commit`, "POST", {});
      expect([late.status, (await json(late)).code]).toEqual([409, "expired"]);
      const expired = await expireImportsJob({
        workerPool: h.db.pool("harbour_worker"),
        appDb: createDatabase(h.db.pool("harbour_app")),
        logger: createLogger("silent"),
      });
      expect(expired).toBeGreaterThanOrEqual(1);
      expect(await stagedRowCount(id)).toBe(0);
      expect(await json(await send(`/v1/imports/${id}`, "GET"))).toMatchObject({
        status: "expired",
      });
      const audits = await ownerSql<{ actor: string | null; scope: Json }>(
        "SELECT actor_tenant_user_id AS actor, scope FROM audit_event WHERE action = 'platform.import.expired' AND resource_id = $1",
        [id],
      );
      expect(audits).toEqual([{ actor: null, scope: { rows: 1, job: "import-expiry" } }]);
    } finally {
      await ownerSql(
        "UPDATE rate_table SET valid_to = '2000-01-02' WHERE tenant_id = $1 AND key = 'import.staging_expiry_days'",
        [DEMO.tenantId],
      );
    }
  });
});

describe("hazard HZ-072 an import waits while sample data is in place", () => {
  it("refuses to commit people into an organisation with sample data", async () => {
    const sql = (text: string, values: unknown[] = []) => ownerSql(text, values, SAMPLE.tenantId);
    await sql(
      `INSERT INTO tenant (id, name, legal_name, legal_form, status)
       VALUES ($1, 'Sample Provider', 'Sample Provider Ltd', 'limited_company', 'onboarding')`,
      [SAMPLE.tenantId],
    );
    await sql("INSERT INTO location (id, name) VALUES ($1, 'Dale House')", [SAMPLE.locationId]);
    await sql(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
       VALUES ($1, $2, 'Olive Owner', 'owner@example.invalid', 'active')`,
      [SAMPLE.ownerId, h.authIds.owner],
    );
    await sql(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES ($1, 'starter', 'Starter', 'tenant',
         '{platform.onboarding.manage,platform.onboarding.read,platform.import.run,people.person.create,people.person.read}')`,
      [SAMPLE.roleId],
    );
    await sql("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      SAMPLE.ownerId,
      SAMPLE.roleId,
    ]);
    expect(
      (await send("/v1/onboarding/sample-data", "POST", undefined, "owner", SAMPLE.tenantId))
        .status,
    ).toBe(200);

    const res = await send(
      "/v1/imports",
      "POST",
      {
        recordType: "people",
        locationId: SAMPLE.locationId,
        csv: `${HEADER}\n${line("Ida", nextNhs())},unknown`,
      },
      "owner",
      SAMPLE.tenantId,
    );
    const { id } = (await res.json()) as { id: string };
    expect(
      (await send(`/v1/imports/${id}/dry-run`, "POST", undefined, "owner", SAMPLE.tenantId)).status,
    ).toBe(200);
    const refused = await send(`/v1/imports/${id}/commit`, "POST", {}, "owner", SAMPLE.tenantId);
    expect([refused.status, (await json(refused)).code]).toEqual([409, "remove_sample_data_first"]);
    const staged = await sql("SELECT id FROM import_row WHERE batch_id = $1", [id]);
    expect(staged).toHaveLength(1);
  });
});

describe("hazard HZ-130 nothing imported is echoed in an audit event", () => {
  it("audits the import's every step by id and count only", async () => {
    const events = await ownerSql<{
      action: string;
      outcome: string;
      scope: Json | null;
      reason: string | null;
    }>(
      `SELECT action, outcome, scope, reason FROM audit_event
        WHERE action LIKE 'platform.import.%' OR action = 'people.person.imported' ORDER BY seq`,
    );
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      "platform.import.uploaded",
      "platform.import.read",
      "platform.import.dry_run",
      "platform.import.committed",
      "people.person.imported",
      "platform.import.undone",
      "platform.import.discarded",
      "platform.import.expired",
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    // Names, local identifiers and NHS numbers (ten digits on their own) never appear.
    expect(JSON.stringify(events)).not.toMatch(/Ida|Hal|Gwen|Nia|Example|R-\d|\b999\d{7}\b/);
    // One imported event per person created.
    const imported = events.filter((e) => e.action === "people.person.imported");
    expect(imported.length).toBeGreaterThanOrEqual(3);
    expect(imported.every((e) => typeof e.scope?.importBatchId === "string")).toBe(true);
  });
});

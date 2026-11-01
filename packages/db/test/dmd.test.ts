import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DmdReleaseFileSource, DmdReleaseFiles } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markDatabaseEnvironment } from "../src/admin/environment";
import {
  DMD_LOAD_LIMITS,
  DmdReleaseFileError,
  dmdDatabaseEnvironment,
  dmdFileFromText,
  dmdFixtureReleaseDirectories,
  loadDmdRelease,
  parseDmdRelease,
  readDmdReleaseDirectory,
} from "../src/dmd";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * The dm+d reference data in the database (integrations.md section 11; INTG-006, MEDS-001;
 * ADR-0080; HZ-113; migration 0110): the invented fixture release loads and reads back, loading it
 * again changes nothing, a newer release adds, invalidates, supersedes and withdraws, and a broken,
 * older or shrunken release is refused whole with its problems in the history while the release in
 * use stays exactly as it was. Only the loader's functions write; the tables are global, read by
 * every role and published for the device subset.
 */

let db: TestDatabase;
const owner = () => db.pool("harbour_owner");
/** The dm+d job's own role (migration 0131); the worker no longer loads (slice 75). */
const job = () => db.pool("harbour_dmd_job");
const worker = () => db.pool("harbour_worker");
const [FIRST_DIR, SECOND_DIR] = dmdFixtureReleaseDirectories() as [string, string];
const first = () => readDmdReleaseDirectory(FIRST_DIR, "fixture");
const second = () => readDmdReleaseDirectory(SECOND_DIR, "fixture");

const ID = {
  vmpExamplomycin250: "91000051000001106",
  vmpTestoprofen400: "91000091000001100",
  vmpExamplomycin500Old: "91000101000001106",
  vmpExamplomycin500New: "91000111000001108",
  vmpFixturol10: "91000121000001104",
  ampSampleGenerics: "91000141000001109",
  amppBrandoprofen: "91000321000001101",
  amppTestoprofen400: "91000351000001109",
  gtinBrandoprofen: "02001234500050",
} as const;

async function textOf(file: DmdReleaseFileSource): Promise<string> {
  let text = "";
  for await (const chunk of file.chunks()) text += chunk;
  return text;
}

/** A release made from a fixture release with another name and some files changed. */
async function variant(
  base: Promise<DmdReleaseFiles>,
  name: string,
  edit: (file: string, content: string) => string | null,
): Promise<DmdReleaseFiles> {
  const release = await base;
  const files = await Promise.all(
    release.files.map(async (f) => {
      const content = edit(f.name, await textOf(f));
      return content === null ? null : dmdFileFromText(f.name, content);
    }),
  );
  return {
    ...release,
    name,
    releasedOn: `${name.slice(-14, -10)}-${name.slice(-10, -8)}-${name.slice(-8, -6)}`,
    files: files.filter((f): f is DmdReleaseFileSource => f !== null),
  };
}

/** A UK date some days from today, as YYYY-MM-DD and as a release name's stamp. */
function daysFromToday(days: number): { date: string; stamp: string } {
  const date = new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });
  return { date, stamp: `${date.replaceAll("-", "")}000001` };
}

/** A fingerprint of every dm+d row, so "unchanged" means unchanged. */
async function fingerprint(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of [
    "dmd_lookup",
    "dmd_vtm",
    "dmd_vmp",
    "dmd_amp",
    "dmd_vmpp",
    "dmd_ampp",
    "dmd_gtin",
  ]) {
    const { rows } = await owner().query<{ f: string }>(
      `SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, ',' ORDER BY t.id)), '') AS f
         FROM ${table} t`,
    );
    out[table] = rows[0]?.f ?? "";
  }
  return out;
}

const history = async () =>
  (
    await owner().query<{
      name: string;
      status: string;
      problems: { code: string }[];
      problem_count: number;
      loaded_by: string;
      changes: Record<string, number>;
    }>(
      "SELECT name, status, problems, problem_count, loaded_by, changes FROM dmd_release ORDER BY started_at, id",
    )
  ).rows;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-113 the dm+d release loader loads whole, once (rules 1 to 4)", () => {
  it("loads the fixture release as the worker and reads it back", async () => {
    const outcome = await loadDmdRelease(job(), await first(), { batchSize: 3 });
    expect(outcome).toMatchObject({ status: "loaded", problemCount: 0 });
    expect(outcome.fileCounts).toMatchObject({ vtm: 4, vmp: 6, amp: 8, vmpp: 6, ampp: 8, gtin: 9 });
    expect(outcome.changes).toMatchObject({ vmp_added: 6, amp_added: 8, gtin_added: 9 });
    const { rows } = await owner().query(
      `SELECT v.name, v.form_code, v.route_codes, v.strength_uom_codes, v.unit_dose_uom_code,
              f.description AS form, v.udfs::text AS udfs
         FROM dmd_vmp v JOIN dmd_lookup f ON f.id = 'form:' || v.form_code
        WHERE v.id = $1`,
      [ID.vmpExamplomycin250],
    );
    expect(rows[0]).toMatchObject({
      name: "Examplomycin 250mg capsules",
      form: "Capsule",
      route_codes: ["91000461000001101"],
      strength_uom_codes: ["91000401000001100"],
      udfs: "1.000",
    });
    const [release] = await history();
    expect(release).toMatchObject({ status: "loaded", loaded_by: "harbour_dmd_job" });
  });

  it("changes nothing when the same release is loaded again", async () => {
    const before = await fingerprint();
    const again = await loadDmdRelease(job(), await first());
    expect(again).toMatchObject({ status: "already_loaded", releaseId: null });
    expect(await fingerprint()).toEqual(before);
    expect(await history()).toHaveLength(1);
  });

  it("finds products by their name's words, as the API searches", async () => {
    const { rows } = await inContext(db.pool("harbour_app"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query<{ name: string }>(
        `SELECT name FROM dmd_vmp WHERE search_name @@ to_tsquery('app.harbour_search', $1)
          ORDER BY length(name), name`,
        ["exampl:* & 250:*"],
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(["Examplomycin 250mg capsules"]);
  });
});

describe("hazard HZ-113 a release that is broken, older or shrunken is refused whole", () => {
  const later = (n: string) => `fixture_dmd_9.9.${n}_20261012000001`;
  const cases: [string, () => Promise<DmdReleaseFiles>, string][] = [
    [
      "an AMP naming a VMP the release lacks",
      () =>
        variant(second(), later("1"), (f, c) =>
          f.startsWith("f_amp2") ? c.replace(ID.vmpExamplomycin250, "91000991000001106") : c,
        ),
      "missing_reference",
    ],
    [
      "an unreadable file",
      () =>
        variant(second(), later("2"), (f, c) =>
          f.startsWith("f_vmpp2") ? c.slice(0, c.length - 40) : c,
        ),
      "unreadable_xml",
    ],
    [
      "a file missing",
      () => variant(second(), later("3"), (f, c) => (f.startsWith("f_gtin2") ? null : c)),
      "file_missing",
    ],
    [
      "a GTIN with a wrong check digit",
      () =>
        variant(second(), later("4"), (f, c) =>
          f.startsWith("f_gtin2") ? c.replace("2001234500012", "2001234500013") : c,
        ),
      "bad_gtin",
    ],
    [
      "a document type declaration",
      () =>
        variant(second(), later("5"), (f, c) =>
          f.startsWith("f_vtm2") ? c.replace("?>\n", '?>\n<!DOCTYPE x [<!ENTITY a "aaaa">]>\n') : c,
        ),
      "unreadable_xml",
    ],
    [
      "an older release than the one in use",
      () => variant(first(), "fixture_dmd_1.0.1_20261001000001", (_f, c) => c),
      "older_than_current",
    ],
    [
      "a concept in use missing",
      () =>
        variant(second(), later("6"), (f, c) =>
          f.startsWith("f_amp2")
            ? c
                .replace(/<AMP>\s*<APID>91000141000001109<\/APID>[\s\S]*?<\/AMP>\s*/, "")
                .replace(
                  /<LIC_ROUTE>\s*<APID>91000141000001109<\/APID>[\s\S]*?<\/LIC_ROUTE>\s*/,
                  "",
                )
            : f.startsWith("f_ampp2")
              ? c.replace(/<AMPP>\s*<APPID>91000301000001108<\/APPID>[\s\S]*?<\/AMPP>\s*/, "")
              : f.startsWith("f_gtin2")
                ? c.replace(/<AMPP>\s*<AMPPID>91000301000001108<\/AMPPID>[\s\S]*?<\/AMPP>\s*/, "")
                : c,
        ),
      "concepts_missing",
    ],
  ];

  it.each(cases)("refuses %s, records why and leaves the release in use", async (_, make, code) => {
    const before = await fingerprint();
    const count = (await history()).length;
    const release = await make();
    const outcome = await loadDmdRelease(job(), release);
    expect(outcome.status).toBe("refused");
    expect(outcome.problems.map((p) => p.code)).toContain(code);
    expect(await fingerprint()).toEqual(before);
    const recorded = await history();
    expect(recorded).toHaveLength(count + 1);
    expect(recorded.at(-1)).toMatchObject({ name: release.name, status: "refused" });
    expect(recorded.at(-1)?.problems.map((p) => p.code)).toContain(code);
    expect(recorded.at(-1)?.problem_count).toBeGreaterThan(0);
  });

  it("refuses an older release in the database too, under the lock", async () => {
    await expect(
      inContext(owner(), null, (c) =>
        c.query("SELECT app.dmd_begin_release('older', '2026-09-01', 'manual', NULL, '{}')"),
      ),
    ).rejects.toMatchObject({ hint: "dmd:older_than_current" });
  });
});

describe("hazard HZ-113 a newer release keeps everything in use (rules 3 and 4)", () => {
  it("adds, changes, invalidates, supersedes, discontinues and withdraws", async () => {
    const outcome = await loadDmdRelease(job(), await second());
    expect(outcome.status).toBe("loaded");
    expect(outcome.changes).toMatchObject({
      vmp_added: 2,
      vmp_invalidated: 1,
      amp_changed: 3,
      superseded: 1,
      gtins_withdrawn: 1,
      gtin_added: 1,
    });
    const vmps = await owner().query<{ id: string; invalid: boolean; superseded_by: string }>(
      "SELECT id, invalid, superseded_by FROM dmd_vmp WHERE id = ANY($1) ORDER BY id",
      [[ID.vmpTestoprofen400, ID.vmpExamplomycin500Old, ID.vmpFixturol10]],
    );
    expect(vmps.rows).toEqual([
      { id: ID.vmpTestoprofen400, invalid: true, superseded_by: null },
      { id: ID.vmpExamplomycin500Old, invalid: false, superseded_by: ID.vmpExamplomycin500New },
      { id: ID.vmpFixturol10, invalid: false, superseded_by: null },
    ]);
    const pack = await owner().query(
      "SELECT discontinued, to_char(discontinued_on, 'YYYY-MM-DD') AS on FROM dmd_ampp WHERE id = $1",
      [ID.amppBrandoprofen],
    );
    expect(pack.rows[0]).toEqual({ discontinued: true, on: "2026-10-20" });
    const gtin = await owner().query(
      "SELECT withdrawn_release_id IS NOT NULL AS withdrawn FROM dmd_gtin WHERE gtin = $1",
      [ID.gtinBrandoprofen],
    );
    expect(gtin.rows).toEqual([{ withdrawn: true }]);
  });

  it("refuses a release that lacks a concept the newer release added", async () => {
    const outcome = await loadDmdRelease(
      job(),
      await variant(first(), "fixture_dmd_1.0.1_20261101000001", (_f, c) => c),
    );
    expect(outcome.status).toBe("refused");
    expect(outcome.problems[0]?.code).toBe("concepts_missing");
    expect(outcome.problems[0]?.message).toContain(ID.vmpFixturol10);
  });
});

describe("hazard HZ-113 only the loader writes dm+d data", () => {
  const app = () => db.pool("harbour_app");
  const asApp = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(TENANT_A, null, "tenant"), fn);

  it("lets the application read every row and change none", async () => {
    const read = await asApp((c) => c.query("SELECT count(*)::int AS n FROM dmd_vmp"));
    expect(read.rows[0]?.n).toBe(8);
    for (const statement of [
      "UPDATE dmd_vmp SET name = 'Changed'",
      "DELETE FROM dmd_gtin",
      "INSERT INTO dmd_vtm (id, name, release_id) SELECT '91000011000001107', 'x', id FROM dmd_release LIMIT 1",
      "SELECT app.dmd_begin_release('x', '2030-01-01', 'manual', NULL, '{}')",
    ]) {
      await expect(
        asApp((c) => c.query(statement)),
        statement,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("gives the worker and the owner no direct write, and lets no one delete", async () => {
    await expect(
      inContext(job(), null, (c) => c.query("UPDATE dmd_vmp SET name = 'Changed'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inContext(owner(), null, (c) =>
        c.query(
          "INSERT INTO dmd_vtm (id, name, release_id) SELECT '91000981000001102', 'x', id FROM dmd_release LIMIT 1",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const deleted = await inContext(owner(), null, (c) => c.query("DELETE FROM dmd_vmp"));
    expect(deleted.rowCount).toBe(0);
    await expect(inContext(owner(), null, (c) => c.query("TRUNCATE dmd_gtin"))).rejects.toThrow(
      /never deleted/,
    );
  });

  it("never changes a finished release, even for the loader's own role", async () => {
    await expect(
      inContext(owner(), null, async (c) => {
        await c.query("SET LOCAL ROLE harbour_dmd_loader");
        return c.query("UPDATE dmd_release SET name = 'Changed'");
      }),
    ).rejects.toThrow(/never changes/);
  });

  it("never commits a release left loading, and loads rows only into a loading release", async () => {
    await expect(
      inContext(owner(), null, (c) =>
        c.query("SELECT app.dmd_begin_release('half', current_date, 'manual', NULL, '{}')"),
      ),
    ).rejects.toThrow(/committed only once/);
    const { rows } = await owner().query<{ id: string }>(
      "SELECT id FROM dmd_release WHERE status = 'loaded' LIMIT 1",
    );
    await expect(
      inContext(job(), null, (c) =>
        c.query("SELECT app.dmd_load_rows($1, 'vtm', '[]')", [rows[0]?.id]),
      ),
    ).rejects.toMatchObject({ hint: "dmd:not_loading" });
  });

  it("records every load and refusal in the audit chain as a platform event, hidden from tenants", async () => {
    const { rows } = await inContext(db.pool("harbour_operator"), null, (c) =>
      c.query<{ action: string; n: number }>(
        `SELECT action, count(*)::int AS n FROM audit_event
          WHERE resource_type = 'dmd_release' AND tenant_id IS NULL GROUP BY action ORDER BY action`,
      ),
    );
    expect(rows).toEqual([
      { action: "medicines.dmd_release.loaded", n: 2 },
      { action: "medicines.dmd_release.refused", n: 8 },
    ]);
    const seen = await asApp((c) =>
      c.query("SELECT 1 FROM audit_event WHERE resource_type = 'dmd_release'"),
    );
    expect(seen.rows).toEqual([]);
  });

  it("publishes the tables for the device subset, readable by the sync role", async () => {
    const { rows } = await owner().query<{ t: string }>(
      "SELECT tablename AS t FROM pg_publication_tables WHERE pubname = 'powersync' AND tablename LIKE 'dmd%' ORDER BY 1",
    );
    expect(rows.map((r) => r.t)).toEqual([
      "dmd_amp",
      "dmd_ampp",
      "dmd_gtin",
      "dmd_lookup",
      "dmd_release",
      "dmd_vmp",
      "dmd_vmpp",
      "dmd_vtm",
    ]);
    const read = await inContext(db.pool("harbour_sync"), null, (c) =>
      c.query("SELECT count(*)::int AS n FROM dmd_gtin"),
    );
    expect(read.rows[0]?.n).toBe(10);
  });
});

describe("hazard HZ-113 a load stays within its limits (security review)", () => {
  const later = (n: string) => `fixture_dmd_9.8.${n}_20261013000001`;

  it.each([
    ["more files than allowed", { ...DMD_LOAD_LIMITS, maxFiles: 3 }],
    ["more bytes than allowed", { ...DMD_LOAD_LIMITS, maxBytes: 1000 }],
  ])("refuses a release with %s before reading it", async (_, limits) => {
    const before = await fingerprint();
    const release = await variant(second(), later("1"), (_f, c) => c);
    const outcome = await loadDmdRelease(job(), release, { limits });
    expect(outcome).toMatchObject({ status: "refused", problems: [{ code: "too_large" }] });
    expect(await fingerprint()).toEqual(before);
  });

  it("stops a load that runs past its time limit and leaves the release in use", async () => {
    const before = await fingerprint();
    const release = await variant(second(), later("2"), (_f, c) => c);
    const outcome = await loadDmdRelease(job(), release, {
      limits: { ...DMD_LOAD_LIMITS, timeoutMs: 0 },
    });
    expect(outcome).toMatchObject({ status: "failed", problems: [{ code: "timed_out" }] });
    expect(await fingerprint()).toEqual(before);
  });

  it("reads each file in chunks and lets other work run between them", async () => {
    let ticks = 0;
    let running = true;
    const tick = () => {
      ticks += 1;
      if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const parsed = await parseDmdRelease(await second(), {
      maxFiles: 64,
      maxBytes: 10_000_000,
      deadline: Date.now() + 60_000,
    });
    running = false;
    expect(parsed.problems).toEqual([]);
    expect(ticks).toBeGreaterThanOrEqual(7);
  });

  it("refuses a symbolic link, in the release directory or as the directory, and over-size directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "harbour-dmd-"));
    const outside = join(root, "outside.xml");
    writeFileSync(outside, "<LOOKUP/>");
    const linked = join(root, "fixture_dmd_9.7.1_20261013000001");
    mkdirSync(linked);
    symlinkSync(outside, join(linked, "f_lookup2_3131026.xml"));
    await expect(readDmdReleaseDirectory(linked, "manual")).rejects.toThrow(DmdReleaseFileError);
    await expect(readDmdReleaseDirectory(linked, "manual")).rejects.toThrow(/symbolic link/);
    const link = join(root, "fixture_dmd_9.7.2_20261013000001");
    symlinkSync(SECOND_DIR, link);
    await expect(readDmdReleaseDirectory(link, "manual")).rejects.toThrow(/symbolic link/);
    await expect(
      readDmdReleaseDirectory(SECOND_DIR, "fixture", { maxFiles: 3, maxBytes: 10_000_000 }),
    ).rejects.toThrow(/more than 3 files/);
    await expect(
      readDmdReleaseDirectory(SECOND_DIR, "fixture", { maxFiles: 64, maxBytes: 1000 }),
    ).rejects.toThrow(/larger than 1000 bytes/);
  });
});

describe("hazard HZ-113 a release dated ahead of today is refused (security review)", () => {
  it("in the loader and in the database", async () => {
    const ahead = daysFromToday(10);
    const release = await variant(second(), `fixture_dmd_9.6.1_${ahead.stamp}`, (_f, c) => c);
    const outcome = await loadDmdRelease(job(), release);
    expect(outcome).toMatchObject({ status: "refused", problems: [{ code: "dated_in_future" }] });
    await expect(
      inContext(job(), null, (c) =>
        c.query("SELECT app.dmd_begin_release('ahead', $1::date, 'manual', NULL, '{}')", [
          ahead.date,
        ]),
      ),
    ).rejects.toMatchObject({ hint: "dmd:dated_in_future" });
  });
});

describe("hazard HZ-113 finish works out what a release holds from the rows written (security review)", () => {
  it("never takes the caller's word, and the caller cannot write the loader's notes", async () => {
    const client = await job().connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        "SELECT app.dmd_begin_release('partial_dmd_1.0.0_20261031000001', current_date, 'manual', NULL, '{}') AS id",
      );
      const id = rows[0]?.id as string;
      await client.query("SAVEPOINT notes");
      await expect(
        client.query(
          `INSERT INTO pg_temp.dmd_seen_${id.replaceAll("-", "")} (kind, id) SELECT 'amp', id FROM dmd_amp`,
        ),
      ).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT notes");
      // One VTM written: everything else in use is missing from what this load wrote.
      const vtm = await client.query(
        "SELECT id, name, abbreviated_name, invalid, previous_id FROM dmd_vtm ORDER BY id LIMIT 1",
      );
      await client.query("SELECT app.dmd_load_rows($1, 'vtm', $2::jsonb)", [
        id,
        JSON.stringify(vtm.rows),
      ]);
      await expect(client.query("SELECT app.dmd_finish_release($1)", [id])).rejects.toMatchObject({
        hint: "dmd:concepts_missing",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("gives each loader function a search path ending in pg_temp", async () => {
    const { rows } = await owner().query<{ name: string; config: string[] }>(
      `SELECT p.proname AS name, p.proconfig AS config FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.prosecdef AND p.proname LIKE 'dmd\\_%' ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([
      "dmd_begin_release",
      "dmd_finish_release",
      "dmd_load_rows",
      "dmd_record_refusal",
    ]);
    for (const row of rows) {
      expect(row.config, row.name).toContain("search_path=pg_catalog, public, pg_temp");
    }
  });
});

describe("hazard HZ-113 the invented fixture loads only into a database marked dev or test (security review)", () => {
  const fixture = () =>
    variant(second(), `fixture_dmd_9.5.1_${daysFromToday(0).stamp}`, (_f, c) => c);

  it("is marked test here, and refuses the fixture under any source once unmarked", async () => {
    expect(await dmdDatabaseEnvironment(owner())).toBe("test");
    await owner().query("DELETE FROM app.database_environment");
    const before = await fingerprint();
    const asManual = { ...(await fixture()), source: "manual" as const };
    const outcome = await loadDmdRelease(owner(), asManual);
    expect(outcome).toMatchObject({
      status: "refused",
      problems: [{ code: "fixture_not_allowed" }],
    });
    expect(await fingerprint()).toEqual(before);
    await expect(
      inContext(owner(), null, (c) =>
        c.query(
          "SELECT app.dmd_begin_release('fixture_dmd_x_20261031000001', current_date, 'manual', NULL, '{}')",
        ),
      ),
    ).rejects.toMatchObject({ hint: "dmd:fixture_not_allowed" });
  });

  it("refuses it in a database marked for real use, which is never marked dev or test again", async () => {
    await markDatabaseEnvironment(owner(), "production");
    const outcome = await loadDmdRelease(job(), await fixture());
    expect(outcome.problems[0]?.code).toBe("fixture_not_allowed");
    await expect(markDatabaseEnvironment(owner(), "test")).rejects.toThrow(/never marked/);
    await expect(owner().query("DELETE FROM app.database_environment")).rejects.toThrow(
      /never marked/,
    );
    await expect(
      job().query("UPDATE app.database_environment SET environment = 'dev'"),
    ).rejects.toThrow(/permission denied/);
    expect(await dmdDatabaseEnvironment(job())).toBe("production");
  });
});

describe("hazard HZ-113 a file that cannot be read refuses the release (security review)", () => {
  it("refuses a file that is not UTF-8, with the release in use unchanged", async () => {
    const before = await fingerprint();
    const release = await variant(second(), "fixture_dmd_9.4.1_20261014000001", (_f, c) => c);
    const broken: DmdReleaseFileSource = {
      name: "f_vtm2_3141026.xml",
      bytes: 3,
      async *chunks() {
        yield "<VIRTUAL_THERAPEUTIC_MOIETIES>";
        throw new TypeError("The encoded data was not valid for encoding utf-8");
      },
    };
    // Not the fixture by name or source: this database is marked production by now.
    const outcome = await loadDmdRelease(job(), {
      ...release,
      name: "unread_dmd_9.4.1_20261014000001",
      source: "manual",
      files: [...release.files.filter((f) => !f.name.startsWith("f_vtm2")), broken],
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.problems.map((p) => p.code)).toContain("unreadable_xml");
    expect(await fingerprint()).toEqual(before);
  });
});

describe("the worker reads only the national rate rows (slice 75, migration 0131)", () => {
  it("sees the national dm+d staleness figure and never an organisation's override", async () => {
    const owner = db.pool("harbour_owner");
    await owner.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('test.slice75.figure', 35, 'days', 'all', '2000-01-01', 'test', 'verified')`,
    );
    await inContext(owner, ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
         VALUES ($1, 'test.slice75.figure', 90, 'days', 'all', '2000-01-01', 'test', 'verified')`,
        [TENANT_A],
      ),
    );
    const client = await worker().connect();
    try {
      const plain = await client.query<{ value: string }>(
        "SELECT value FROM rate_table WHERE key = 'test.slice75.figure'",
      );
      expect(plain.rows.map((r) => Number(r.value))).toEqual([35]);
      // Setting an organisation does not show its rows to the worker.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT_A]);
      const asTenant = await client.query<{ value: string }>(
        "SELECT value FROM rate_table WHERE key = 'test.slice75.figure'",
      );
      expect(asTenant.rows.map((r) => Number(r.value))).toEqual([35]);
      await client.query("ROLLBACK");
      await expect(
        client.query("UPDATE rate_table SET value = 1 WHERE key = 'test.slice75.figure'"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      client.release();
    }
  });
});

describe("hazard HZ-113 only the dm+d job's own role loads (security review of slice 75, H1)", () => {
  it("lets the worker call no loader function, and gives the job no organisation's rows", async () => {
    await expect(
      worker().query("SELECT app.dmd_finish_release('00000000-0000-7000-8000-000000000000')"),
    ).rejects.toThrow(/permission denied/);
    for (const table of ["outbox_event", "notification", "person", "rate_table", "audit_event"]) {
      await expect(job().query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toThrow(
        /permission denied/,
      );
    }
    const { rows } = await job().query<{ n: string }>("SELECT count(*) AS n FROM dmd_release");
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});

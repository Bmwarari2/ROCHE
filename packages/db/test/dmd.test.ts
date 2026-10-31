import type { DmdReleaseFiles } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dmdFixtureReleaseDirectories, loadDmdRelease, readDmdReleaseDirectory } from "../src/dmd";
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

/** A release made from a fixture release with another name and some files changed. */
function variant(
  base: DmdReleaseFiles,
  name: string,
  edit: (file: string, content: string) => string | null,
): DmdReleaseFiles {
  return {
    ...base,
    name,
    releasedOn: `${name.slice(-14, -10)}-${name.slice(-10, -8)}-${name.slice(-8, -6)}`,
    files: base.files.flatMap((f) => {
      const content = edit(f.name, f.content);
      return content === null ? [] : [{ name: f.name, content }];
    }),
  };
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
    const outcome = await loadDmdRelease(worker(), first(), { batchSize: 3 });
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
    expect(release).toMatchObject({ status: "loaded", loaded_by: "harbour_worker" });
  });

  it("changes nothing when the same release is loaded again", async () => {
    const before = await fingerprint();
    const again = await loadDmdRelease(worker(), first());
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
  const cases: [string, () => DmdReleaseFiles, string][] = [
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
    const release = make();
    const outcome = await loadDmdRelease(worker(), release);
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
    const outcome = await loadDmdRelease(worker(), second());
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
      worker(),
      variant(first(), "fixture_dmd_1.0.1_20261101000001", (_f, c) => c),
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
      inContext(worker(), null, (c) => c.query("UPDATE dmd_vmp SET name = 'Changed'")),
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
        c.query("SELECT app.dmd_begin_release('half', '2030-01-01', 'manual', NULL, '{}')"),
      ),
    ).rejects.toThrow(/committed only once/);
    const { rows } = await owner().query<{ id: string }>(
      "SELECT id FROM dmd_release WHERE status = 'loaded' LIMIT 1",
    );
    await expect(
      inContext(worker(), null, (c) =>
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

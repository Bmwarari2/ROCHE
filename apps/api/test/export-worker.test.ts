import { DEMO } from "@harbour/db/seed";
import {
  type DocumentStoragePort,
  EXPORT_SCHEMA_VERSION,
  type ExportManifest,
} from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExportJobDeps, runQueuedExports, sweepExports } from "../src/jobs/exports";
import { createLogger } from "../src/logger";
import { held } from "../src/services/export-build";
import { createHarness, type Harness, OTHER } from "./support/harness";
import { unzip } from "./support/unzip";

/**
 * The full export's worker (PLAT-015; platform-completions.md rules 10 to 14; hazards HZ-070 and
 * HZ-071): one snapshot as harbour_app in the organisation's context, written as a streamed ZIP to
 * the exports bucket; only the organisation's rows and only exported columns; a complete manifest
 * and current summary; the requester told by ids only; archives past expiry deleted and recorded;
 * an export left running failed.
 */

let h: Harness;
let deps: ExportJobDeps;

beforeAll(async () => {
  h = await createHarness();
  deps = {
    workerPool: h.db.pool("harbour_worker"),
    appPool: h.db.pool("harbour_app"),
    appDb: h.handle.services.db,
    logger: createLogger("silent"),
    storage: h.handle.services.storage,
    exportStorage: h.handle.services.exportStorage,
  };
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function asOwnerDb(sql: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(sql, params);
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("table-driven: which rows a legal hold keeps in the export (rule 11)", () => {
  const P = "0194d000-0000-7000-8600-000000000001";
  const N = "0194d000-0000-7000-8600-0000000000aa";
  const holds = [
    { personId: P, subjectType: null, subjectId: null, releasedAt: null },
    { personId: null, subjectType: "care_note", subjectId: N, releasedAt: null },
  ];
  it.each([
    ["a row flagged on hold", "document", { id: "x", legal_hold: true }, true],
    ["a row about a person on hold", "care_note", { id: "y", person_id: P }, true],
    ["the person on hold", "person", { id: P }, true],
    ["a record held by itself", "care_note", { id: N }, true],
    ["the same id in another table", "observation", { id: N }, false],
    ["anyone else", "care_note", { id: "z", person_id: "other" }, false],
  ] as const)("%s: %s", (_, table, row, expected) => {
    expect(held(table, row, holds)).toBe(expected);
  });
});

describe("hazard HZ-070 hazard HZ-071 building the full export", () => {
  let id = "";
  let files = new Map<string, Buffer>();
  let breachId = "";

  it("builds a queued export into a complete archive, and tells the requester by ids only", async () => {
    // A breach register entry, which the free full export must include (#156 follow-up).
    const breach = await h.request("/v1/data-protection/breaches", {
      method: "POST",
      body: { summary: "A letter went to the wrong address.", awareAt: new Date().toISOString() },
      token: h.tokens.quality,
      tenant: DEMO.tenantId,
    });
    expect(breach.status).toBe(201);
    breachId = ((await breach.json()) as { id: string }).id;
    const asked = await h.request("/v1/exports", {
      method: "POST",
      body: {},
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    expect(asked.status).toBe(202);
    id = ((await asked.json()) as { id: string }).id;
    expect(await runQueuedExports(deps)).toBe(1);

    const [row] = await asOwnerDb(
      "SELECT status, schema_version, bytes, manifest_sha256, snapshot_at FROM tenant_export WHERE id = $1",
      [id],
    );
    expect(row).toMatchObject({ status: "ready", schema_version: EXPORT_SCHEMA_VERSION });
    const [note] = await asOwnerDb(
      "SELECT recipient_tenant_user_id, title, body, link, source_id FROM notification WHERE source_id = $1",
      [id],
    );
    expect(note).toMatchObject({
      recipient_tenant_user_id: DEMO.users.owner.id,
      title: "Your data export is ready",
      link: "/settings/export",
    });
    const audits = await asOwnerDb("SELECT action FROM audit_event WHERE resource_id = $1", [id]);
    expect(audits.map((a) => a.action)).toContain("platform.export.ready");

    const download = await h.request(`/v1/exports/${id}/download`, {
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    expect(download.status).toBe(200);
    const archive = new Uint8Array(await download.arrayBuffer());
    expect(archive.length).toBe(Number(row?.bytes));
    files = unzip(archive);
  });

  it("includes the breach register (the export reads it in the organisation's context)", () => {
    expect(files.get("tables/dp_breach.csv")?.toString()).toContain(breachId);
  });

  it("writes a complete manifest, the schema and one summary row per person", () => {
    const manifest = JSON.parse(files.get("manifest.json")?.toString() ?? "{}") as ExportManifest;
    expect(manifest.problems).toEqual([]);
    expect(manifest.complete).toBe(true);
    expect(manifest.exportId).toBe(id);
    expect(files.has("schema.json")).toBe(true);
    expect(files.has("destroyed.csv")).toBe(true);
    const people = manifest.tables.find((t) => t.name === "person")?.rows ?? 0;
    expect(people).toBeGreaterThan(0);
    const summary = files.get("current_summary.csv")?.toString().trim().split("\n") ?? [];
    expect(summary.length - 1).toBe(people);
    for (const table of manifest.tables) {
      expect(files.has(`tables/${table.name}.csv`), table.name).toBe(true);
      expect(files.has(`tables/${table.name}.jsonl`), table.name).toBe(true);
    }
  });

  it("holds only the organisation's rows and never a secret or internal column", () => {
    const all = [...files.values()].map((b) => b.toString("utf8")).join("\n");
    expect(all).not.toContain(OTHER.personId);
    expect(all).not.toContain(OTHER.tenantId);
    const person = files.get("tables/person.jsonl")?.toString() ?? "";
    expect(person).toContain(DEMO.tenantId);
    for (const secret of ["storage_key", "token_hash", "auth_user_id", "secret_ref"]) {
      const headers = [...files.entries()]
        .filter(([path]) => path.endsWith(".csv"))
        .map(([, b]) => b.toString().split("\n")[0] ?? "");
      expect(
        headers.some((line) => line.split(",").includes(secret)),
        secret,
      ).toBe(false);
    }
    // The auth schema (passwords, sessions, passkeys, authenticator secrets) is never read.
    for (const table of ["user", "session", "account", "verification", "passkey", "two_factor"]) {
      expect(files.has(`tables/${table}.csv`), table).toBe(false);
    }
  });

  it("deletes archives past their expiry and records it, and fails an export left running", async () => {
    const asked = await h.request("/v1/exports", {
      method: "POST",
      body: {},
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    const stuck = ((await asked.json()) as { id: string }).id;
    await asOwnerDb(
      "UPDATE tenant_export SET status = 'running', started_at = now() - interval '13 hours' WHERE id = $1",
      [stuck],
    );
    const later = new Date(Date.now() + 400 * 24 * 3_600_000);
    expect(await sweepExports(deps, later)).toBe(2);
    const rows = await asOwnerDb(
      "SELECT id, status FROM tenant_export WHERE id = ANY ($1) ORDER BY id",
      [[id, stuck]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
      [id]: "expired",
      [stuck]: "failed",
    });
    const key = `tenants/${DEMO.tenantId}/exports/${id}/export.zip`;
    expect(await h.handle.services.exportStorage.get(key)).toBeNull();
    const audits = await asOwnerDb(
      "SELECT action, scope FROM audit_event WHERE resource_id = $1 AND action = 'platform.export.expired'",
      [id],
    );
    expect(audits).toEqual([
      { action: "platform.export.expired", scope: { archiveDeleted: true } },
    ]);
  });
});

describe("hazard HZ-071 a failed source or upload never leaves the worker hanging", () => {
  async function asked(): Promise<string> {
    await asOwnerDb(
      "UPDATE tenant_export SET status = 'failed', failed_at = now() WHERE status IN ('queued', 'running')",
    );
    const response = await h.request("/v1/exports", {
      method: "POST",
      body: {},
      token: h.tokens.owner,
      tenant: DEMO.tenantId,
    });
    return ((await response.json()) as { id: string }).id;
  }
  const idle = () => deps.appPool.totalCount - deps.appPool.idleCount;
  /** The exports bucket with another way of writing a stream. */
  const withPut = (putStream: DocumentStoragePort["putStream"]): DocumentStoragePort => {
    const real = deps.exportStorage;
    return {
      provider: real.provider,
      put: (key, bytes, type) => real.put(key, bytes, type),
      get: (key) => real.get(key),
      destroy: (key) => real.destroy(key),
      health: () => real.health(),
      getStream: (key) => real.getStream(key),
      putStream,
    };
  };

  it.each([
    [
      "the upload fails partway",
      () =>
        withPut(async (_key, source) => {
          let read = 0;
          for await (const chunk of source) {
            read += chunk.length;
            if (read > 1_000) throw new Error("upload failed");
          }
        }),
    ],
    [
      "the upload never starts reading",
      () => withPut(() => Promise.reject(new Error("bucket unreachable"))),
    ],
  ])(
    "fails the export when %s, releasing the snapshot",
    async (_, broken) => {
      const id = await asked();
      const before = idle();
      await runQueuedExports({ ...deps, exportStorage: broken() });
      expect(idle()).toBe(before);
      const [row] = await asOwnerDb("SELECT status, problems FROM tenant_export WHERE id = $1", [
        id,
      ]);
      expect(row).toMatchObject({ status: "failed", problems: [{ kind: "build_error" }] });
      const notes = await asOwnerDb("SELECT kind FROM notification WHERE source_id = $1", [id]);
      expect(notes).toEqual([{ kind: "platform.export.failed" }]);
      const key = `tenants/${DEMO.tenantId}/exports/${id}/export.zip`;
      expect(await deps.exportStorage.get(key)).toBeNull();
    },
    30_000,
  );

  it("deletes the archive, and tells no one, when the export was cancelled while it was built", async () => {
    const id = await asked();
    const cancelling = withPut(async (key, source, type) => {
      await deps.exportStorage.putStream(key, source, type);
      // Cancelled in the requester's name, as the route does.
      await asOwnerDb(
        `WITH me AS (SELECT set_config('app.user_id', requested_by::text, true)
                       FROM tenant_export WHERE id = $1)
         UPDATE tenant_export SET status = 'revoked', revoked_at = now(),
           revoked_by = requested_by FROM me WHERE id = $1`,
        [id],
      );
    });
    await runQueuedExports({ ...deps, exportStorage: cancelling });
    const key = `tenants/${DEMO.tenantId}/exports/${id}/export.zip`;
    expect(await deps.exportStorage.get(key)).toBeNull();
    expect(await asOwnerDb("SELECT kind FROM notification WHERE source_id = $1", [id])).toEqual([]);
  }, 30_000);
});

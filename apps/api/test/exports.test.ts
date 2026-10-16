import { createHash } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxHandlers } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The free full export's routes (PLAT-015; platform-completions.md rules 12 to 15; hazards HZ-011
 * and HZ-070): asked for and downloaded only by holders of platform.export.create with step-up;
 * one at a time; the archive fetched once, by the requester, then deleted; every step audited by
 * opaque id. The worker that builds the archive is stood in for here by the owner role.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const post = (path: string, who = "owner", body: unknown = {}) =>
  h.request(path, { method: "POST", body, ...as(who) });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;
type Item = { id: string; status: string; mayDownload: boolean; downloadedAt: string | null };

async function asJob(sql: string, params: unknown[]) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

/** Stands in for the export worker: marks the export ready with an archive in storage. */
async function makeReady(id: string, bytes: Uint8Array, expiresIn = "1 day") {
  const key = `tenants/${DEMO.tenantId}/exports/${id}/export.zip`;
  await h.handle.services.exportStorage.put(key, bytes, "application/zip");
  await asJob("UPDATE tenant_export SET status = 'running', started_at = now() WHERE id = $1", [
    id,
  ]);
  await asJob(
    `UPDATE tenant_export SET status = 'ready', snapshot_at = now(), ready_at = now(),
       expires_at = now() + $5::interval, storage_key = $2, bytes = $3,
       manifest_sha256 = $4, schema_version = '1.1.0' WHERE id = $1`,
    [id, key, bytes.length, createHash("sha256").update("manifest").digest("hex"), expiresIn],
  );
  return key;
}

const actions = async (id: string) =>
  (await asJob("SELECT action, outcome, reason FROM audit_event WHERE resource_id = $1", [id])).map(
    (r) => `${r.action}:${r.outcome}${r.reason ? `:${r.reason}` : ""}`,
  );

describe("hazard HZ-070 asking for, listing and cancelling an export", () => {
  let first = "";

  it("queues one export at a time, and asking again answers with it", async () => {
    const response = await post("/v1/exports");
    expect(response.status).toBe(202);
    const item = (await response.json()) as Item;
    expect(item).toMatchObject({ status: "queued", mayDownload: false });
    first = item.id;
    const again = await post("/v1/exports");
    expect(again.status).toBe(200);
    expect(((await again.json()) as Item).id).toBe(first);
    expect(await actions(first)).toEqual(["platform.export.requested:success"]);
  });

  it("lists the organisation's exports for the owner, never the storage key", async () => {
    const response = await h.request("/v1/exports", as("owner"));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(first);
    expect(text).not.toContain("storage");
    expect(text).not.toContain("exports/");
  });

  it.each([
    ["manager", 403],
    ["carer", 403],
  ])("refuses the %s, who does not hold platform.export.create", async (who, status) => {
    expect((await post("/v1/exports", who)).status).toBe(status);
    expect((await h.request("/v1/exports", as(who))).status).toBe(status);
    expect((await h.request(`/v1/exports/${first}/download`, as(who))).status).toBe(status);
  });

  it("never crosses organisations", async () => {
    // The owner is no member of the other organisation; its manager is none of this one's.
    expect((await h.request("/v1/exports", as("owner", OTHER.tenantId))).status).toBe(403);
    expect((await h.request("/v1/exports", as("rae"))).status).toBe(403);
  });

  it("needs a fresh step-up to ask and to list", async () => {
    const auth = h.db.pool("harbour_auth");
    await ageSession(auth, h.tokens.owner?.split(".")[0] ?? "", 3_600);
    try {
      const refused = await post("/v1/exports");
      expect(refused.status).toBe(403);
      expect(await codeOf(refused)).toBe("step_up_required");
      expect((await h.request("/v1/exports", as("owner"))).status).toBe(403);
    } finally {
      await ageSession(auth, h.tokens.owner?.split(".")[0] ?? "", 0);
    }
  });

  it("cancels a queued export, once, in the canceller's name", async () => {
    expect((await post(`/v1/exports/${first}/revoke`)).status).toBe(204);
    expect((await post(`/v1/exports/${first}/revoke`)).status).toBe(409);
    expect(await actions(first)).toContain("platform.export.revoked:success");
    // Another can now be asked for.
    expect((await post("/v1/exports")).status).toBe(202);
  });
});

describe("hazard HZ-070 downloading an export once", () => {
  /** A fresh export, ready with an archive, after cancelling any still in hand. */
  async function readyExport(bytes: Uint8Array, expiresIn = "1 day") {
    await asJob(
      `UPDATE tenant_export SET status = 'failed', failed_at = now()
        WHERE status IN ('queued', 'running')`,
      [],
    );
    const created = (await (await post("/v1/exports")).json()) as Item;
    const key = await makeReady(created.id, bytes, expiresIn);
    return { id: created.id, key };
  }
  const download = (id: string, who = "owner") => h.request(`/v1/exports/${id}/download`, as(who));
  const archive = new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]);

  it("streams the archive to the requester once, records it, and has the worker delete it", async () => {
    const queued = (await (await post("/v1/exports")).json()) as Item;
    expect((await download(queued.id)).status).toBe(409);
    const { id, key } = await readyExport(archive);
    const listed = (await (await h.request("/v1/exports", as("owner"))).json()) as {
      items: Item[];
    };
    expect(listed.items.find((i) => i.id === id)?.mayDownload).toBe(true);

    const response = await download(id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="harbour-export-${id}.zip"`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);

    const again = await download(id);
    expect(again.status).toBe(410);
    expect(await codeOf(again)).toBe("export_already_downloaded");
    const [row] = await asJob(
      "SELECT downloaded_at IS NOT NULL AS done, downloaded_by FROM tenant_export WHERE id = $1",
      [id],
    );
    expect(row).toEqual({ done: true, downloaded_by: DEMO.users.owner.id });
    expect(await actions(id)).toEqual(
      expect.arrayContaining([
        "platform.export.downloaded:success",
        "platform.export.downloaded:denied:already_downloaded",
      ]),
    );

    // The worker deletes the archive from the outbox event (retried until it is gone).
    const [event] = await asJob(
      "SELECT tenant_id, event_type, aggregate_id, payload FROM outbox_event WHERE aggregate_id = $1",
      [id],
    );
    expect(event).toMatchObject({
      event_type: "platform.export.downloaded",
      payload: { exportId: id },
    });
    const handler = outboxHandlers({
      workerPool: h.db.pool("harbour_worker"),
      appDb: h.handle.services.db,
      logger: createLogger("silent"),
      exportStorage: h.handle.services.exportStorage,
    }).get("platform.export.downloaded");
    await handler?.({
      id: "e",
      tenantId: DEMO.tenantId,
      eventType: "platform.export.downloaded",
      aggregateId: id,
      payload: { exportId: id },
    });
    expect(await h.handle.services.exportStorage.get(key)).toBeNull();
  });

  it("lets only one of two downloads at once through", async () => {
    const { id } = await readyExport(archive);
    const results = await Promise.all([download(id), download(id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    await Promise.all(results.map((r) => r.arrayBuffer()));
  });

  it("leaves the download untaken when the archive cannot be read, so it can be tried again", async () => {
    const { id, key } = await readyExport(archive);
    await h.handle.services.exportStorage.destroy(key);
    expect((await download(id)).status).toBe(410);
    const [row] = await asJob("SELECT downloaded_at FROM tenant_export WHERE id = $1", [id]);
    expect(row).toEqual({ downloaded_at: null });
  });

  it("refuses another holder of the permission, and an id from another organisation", async () => {
    const { id } = await readyExport(archive);
    await asJob(
      `INSERT INTO role_assignment (tenant_user_id, role_id, organisation_wide)
       SELECT $1, id, false FROM role WHERE key = 'owner'`,
      [LODGE.qualityLeadId],
    );
    const other = await download(id, "quality");
    expect(other.status).toBe(403);
    expect(await codeOf(other)).toBe("not_requester");

    const foreign = "0194e000-0000-7000-8000-00000000e001";
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [OTHER.tenantId],
      );
      await client.query("INSERT INTO tenant_export (id, requested_by) VALUES ($1, $2)", [
        foreign,
        OTHER.managerId,
      ]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await download(foreign)).status).toBe(404);
  });

  it("refuses an expired export", async () => {
    const { id } = await readyExport(new Uint8Array([1, 2, 3]), "1 second");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await download(id);
    expect(response.status).toBe(410);
    expect(await codeOf(response)).toBe("export_expired");
  });
});

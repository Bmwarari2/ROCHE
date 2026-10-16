import { createHash } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, OTHER } from "./support/harness";

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
async function makeReady(id: string, bytes: Uint8Array) {
  const key = `tenants/${DEMO.tenantId}/exports/${id}/export.zip`;
  await h.handle.services.storage.put(key, bytes, "application/zip");
  await asJob("UPDATE tenant_export SET status = 'running', started_at = now() WHERE id = $1", [
    id,
  ]);
  await asJob(
    `UPDATE tenant_export SET status = 'ready', snapshot_at = now(), ready_at = now(),
       expires_at = now() + interval '1 day', storage_key = $2, bytes = $3,
       manifest_sha256 = $4, schema_version = '1.1.0' WHERE id = $1`,
    [id, key, bytes.length, createHash("sha256").update("manifest").digest("hex")],
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
  it("hands the archive to the requester once, records it, then deletes the archive", async () => {
    const list = (await (await h.request("/v1/exports", as("owner"))).json()) as { items: Item[] };
    const queued = list.items.find((i) => i.status === "queued");
    expect(queued).toBeDefined();
    const id = queued?.id ?? "";
    expect((await h.request(`/v1/exports/${id}/download`, as("owner"))).status).toBe(409);

    const archive = new Uint8Array([80, 75, 5, 6, ...new Array(18).fill(0)]);
    const key = await makeReady(id, archive);
    const listed = (await (await h.request("/v1/exports", as("owner"))).json()) as {
      items: Item[];
    };
    expect(listed.items.find((i) => i.id === id)?.mayDownload).toBe(true);

    const response = await h.request(`/v1/exports/${id}/download`, as("owner"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);
    expect(await h.handle.services.storage.get(key)).toBeNull();

    const again = await h.request(`/v1/exports/${id}/download`, as("owner"));
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
  });

  it("refuses an expired export", async () => {
    const created = (await (await post("/v1/exports")).json()) as Item;
    await makeReady(created.id, new Uint8Array([1, 2, 3]));
    await asJob(
      "UPDATE tenant_export SET expires_at = ready_at + interval '1 second' WHERE id = $1",
      [created.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await h.request(`/v1/exports/${created.id}/download`, as("owner"));
    expect(response.status).toBe(410);
    expect(await codeOf(response)).toBe("export_expired");
  });
});

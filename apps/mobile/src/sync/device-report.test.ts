import { SYNC_DEVICE_REPORT_MAX_LOCATIONS, SyncDeviceReport } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { all, openLocalDatabase } from "../test-support/local-db";
import {
  buildDeviceReport,
  fallbackHoldReport,
  flushPendingReport,
  holdReport,
  MAX_REPORT_LOCATIONS,
  oldestAgeSeconds,
  PENDING_REPORT_ITEM,
  parsePendingReport,
  REPORT_REPEAT_MS,
  type ReportDb,
  reportOrKeep,
  reportSent,
  sendDeviceReport,
  shouldSendReport,
  withOwner,
} from "./device-report";
import type { ApiOptions } from "./discards";

const API = "https://api.example.invalid";
const NOW = new Date("2026-10-11T07:30:00.000Z");
const [BEA] = demoPeople.map((p) => p.id) as [string];

const report = (overrides: Partial<SyncDeviceReport> = {}): SyncDeviceReport => ({
  unsent: 2,
  refused: 1,
  held: 0,
  blocked: 0,
  oldestAgeSeconds: 3600,
  reportedAt: NOW.toISOString(),
  ...overrides,
});

function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    store: {
      read: async (key: string) => items.get(key) ?? null,
      write: async (key: string, value: string) => {
        items.set(key, value);
      },
      remove: async (key: string) => {
        items.delete(key);
      },
    },
  };
}

function server(statuses: Array<number | Error>) {
  const bodies: unknown[] = [];
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = statuses.shift() ?? 204;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  };
  return { fetch, bodies };
}

const options = (fetch: FetchLike, tenantId = DEMO_TENANT_ID): ApiOptions => ({
  apiUrl: API,
  fetch,
  token: "tok",
  tenantId,
  deviceId: "client-1",
});

describe("hazard HZ-006 the device tells the server what it has not sent (queue depth)", () => {
  it("counts the queue, refusals and holds, and the age of the oldest, with no personal data", async () => {
    const db = await openLocalDatabase();
    db.prepare(
      "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "i1",
      DEMO_TENANT_ID,
      BEA,
      "care_note",
      "invalid",
      "Closed",
      '{"body":"x"}',
      "2026-10-11T05:30:00.000Z",
    );
    db.prepare(
      "INSERT INTO held_entry (id, tenant_id, person_id, record_table, op, payload, position, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "h1",
      DEMO_TENANT_ID,
      BEA,
      "care_note",
      "PUT",
      '{"body":"y"}',
      1,
      "2026-10-11T06:30:00.000Z",
    );
    const source: ReportDb = {
      getUploadQueueStats: async () => ({ count: 3 }),
      getOptional: async <T>(sql: string) => (all<T>(db, sql, [])[0] ?? null) as T | null,
      getCrudBatch: async () => ({
        crud: [{ opData: { device_time: "2026-10-11T03:10:00.000Z", body: "Settled" } }],
      }),
    };
    const built = await buildDeviceReport(source, NOW);
    expect(built).toEqual({
      unsent: 3,
      refused: 1,
      held: 1,
      blocked: 0,
      oldestAgeSeconds: 4 * 3600 + 20 * 60,
      // The hold started when its oldest entry was held (clinical review round 4, H2).
      heldSince: "2026-10-11T06:30:00.000Z",
      reportedAt: NOW.toISOString(),
    });
    expect(SyncDeviceReport.safeParse(built).success).toBe(true);
    expect(JSON.stringify(built)).not.toMatch(/Settled|body|i1|h1/);
  });

  it("says when the hold started only while entries are held", async () => {
    const db = await openLocalDatabase();
    const source: ReportDb = {
      getUploadQueueStats: async () => ({ count: 1 }),
      getOptional: async <T>(sql: string) => (all<T>(db, sql, [])[0] ?? null) as T | null,
      getCrudBatch: async () => null,
    };
    expect((await buildDeviceReport(source, NOW)).heldSince).toBeNull();
    // A hold that has just started reports its own start; an unreadable time changes nothing.
    expect(holdReport(report(), "2026-10-11T07:00:00.000Z").heldSince).toBe(
      "2026-10-11T07:00:00.000Z",
    );
    expect(holdReport(report(), "")).toEqual(report());
  });

  it("hazard HZ-040 counts the entries a failed deletion left, so the manager's task stays open (round 5, C-M3)", async () => {
    const db = await openLocalDatabase();
    for (const [id, code] of [
      ["b1", "held_discard_failed"],
      ["b2", "held_discard_failed"],
      ["r1", "invalid"],
    ]) {
      db.prepare(
        "INSERT INTO upload_issue (id, tenant_id, person_id, record_table, code, message, payload, rejected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, DEMO_TENANT_ID, BEA, "care_note", code, "x", "{}", "2026-10-11T05:30:00.000Z");
    }
    const source: ReportDb = {
      getUploadQueueStats: async () => ({ count: 0 }),
      getOptional: async <T>(sql: string) => (all<T>(db, sql, [])[0] ?? null) as T | null,
      getCrudBatch: async () => null,
    };
    expect(await buildDeviceReport(source, NOW)).toMatchObject({ refused: 3, blocked: 2 });
  });

  it("hazard HZ-040 still reports a hold whose entries could not be counted (round 5, C-M4)", () => {
    const fallback = fallbackHoldReport(null, NOW);
    expect(fallback).toMatchObject({ held: 1, unsent: 0, blocked: 0, oldestAgeSeconds: null });
    expect(fallbackHoldReport(4, NOW).held).toBe(4);
    expect(SyncDeviceReport.safeParse(holdReport(fallback, NOW.toISOString())).success).toBe(true);
  });

  it("has no age when nothing waits, and never a negative one", () => {
    expect(oldestAgeSeconds([null, undefined], NOW)).toBeNull();
    expect(oldestAgeSeconds(["2026-10-12T00:00:00.000Z"], NOW)).toBe(0);
  });

  it("sends when the counts change, and every half hour while anything waits", () => {
    expect(shouldSendReport(null, report(), NOW)).toBe(true);
    const last = reportSent(report(), NOW);
    expect(shouldSendReport(last, report(), new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(shouldSendReport(last, report({ unsent: 3 }), NOW)).toBe(true);
    expect(shouldSendReport(last, report(), new Date(NOW.getTime() + REPORT_REPEAT_MS))).toBe(true);
    const empty = report({ unsent: 0, refused: 0, held: 0, oldestAgeSeconds: null });
    const sentEmpty = reportSent(empty, NOW);
    expect(shouldSendReport(sentEmpty, empty, new Date(NOW.getTime() + REPORT_REPEAT_MS))).toBe(
      false,
    );
  });

  it("posts the report to the API", async () => {
    const { fetch, bodies } = server([204]);
    expect(await sendDeviceReport(options(fetch), report())).toBe(true);
    expect(bodies[0]).toEqual(report());
    expect(await sendDeviceReport(options(server([new Error("offline")]).fetch), report())).toBe(
      false,
    );
  });

  it("keeps a hold's report for the next session in the same tenant when the session has ended", async () => {
    const { store, items } = memoryStore();
    const pending = {
      tenantId: DEMO_TENANT_ID,
      report: holdReport(report({ unsent: 0, held: 2 }), "2026-10-11T06:30:00.000Z"),
    };
    expect(pending.report.heldSince).toBe("2026-10-11T06:30:00.000Z");
    // The session that ended cannot send it.
    expect(await reportOrKeep(store, pending, options(server([401]).fetch))).toBe("kept");
    expect(parsePendingReport(items.get(PENDING_REPORT_ITEM) ?? null)).toEqual(pending);
    // Another tenant's session does not send it.
    const other = server([]);
    expect(
      await flushPendingReport(store, options(other.fetch, "00000000-0000-4000-8000-0000000000a2")),
    ).toBe("kept");
    expect(other.bodies).toEqual([]);
    // The next session in the tenant does, and it leaves the keystore.
    const next = server([204]);
    expect(await flushPendingReport(store, options(next.fetch))).toBe("sent");
    expect(next.bodies[0]).toEqual(pending.report);
    expect(items.has(PENDING_REPORT_ITEM)).toBe(false);
    expect(await flushPendingReport(store, options(next.fetch))).toBe("none");
  });

  it.each([
    ["not JSON", "{not json"],
    ["a tenant that is not an id", JSON.stringify({ tenantId: "Example Care", report: report() })],
    [
      "words in place of counts",
      JSON.stringify({ tenantId: DEMO_TENANT_ID, report: { ...report(), held: "two" } }),
    ],
  ])("ignores a waiting report that is %s", (_case, raw) => {
    expect(parsePendingReport(raw)).toBeNull();
  });
});

describe("hazard HZ-040 a hold's report names its owner, their locations and the device that held it (clinical review round 6, M1 and M2)", () => {
  const OWNER = "0194d000-0000-7000-8000-000000000304";
  const HOME = "0194d000-0000-7000-8000-000000000101";
  const LODGE = "0194d000-0000-7000-8000-000000000102";
  const HELD_ON = "0199d000-0000-4000-8000-00000000de01";

  it("adds the owner and the locations of their sync scope, opaque ids only, as the API takes them", () => {
    expect(MAX_REPORT_LOCATIONS).toBe(SYNC_DEVICE_REPORT_MAX_LOCATIONS);
    const named = withOwner(report(), OWNER, [HOME, "Harbour Lodge", HOME.toUpperCase(), LODGE]);
    expect(named).toEqual({ ...report(), ownerTenantUserId: OWNER, locationIds: [HOME, LODGE] });
    expect(SyncDeviceReport.safeParse(named).success).toBe(true);
    // Nothing known: nothing added.
    expect(withOwner(report(), null, [])).toEqual(report());
    const many = Array.from(
      { length: 60 },
      (_, i) => `0194d000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    expect(withOwner(report(), OWNER, many).locationIds).toHaveLength(MAX_REPORT_LOCATIONS);
  });

  it("keeps them while the report waits, and sends it under the id of the device that held the entries", async () => {
    const { store, items } = memoryStore();
    const pending = {
      tenantId: DEMO_TENANT_ID,
      report: withOwner(
        report({ unsent: 0, held: 2, heldSince: "2026-10-11T06:30:00.000Z" }),
        OWNER,
        [HOME],
      ),
      deviceId: HELD_ON,
    };
    expect(await reportOrKeep(store, pending, null)).toBe("kept");
    expect(parsePendingReport(items.get(PENDING_REPORT_ITEM) ?? null)).toEqual(pending);
    // The next session on the device has a new database, so a new device id; the report still
    // names the device that held the entries.
    const sent: Array<{ device: string | null; body: unknown }> = [];
    const fetch: FetchLike = async (_url, init) => {
      const headers = new Headers(init?.headers as Record<string, string>);
      sent.push({ device: headers.get("x-harbour-device"), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    };
    expect(await flushPendingReport(store, options(fetch))).toBe("sent");
    expect(sent).toEqual([{ device: HELD_ON, body: pending.report }]);
  });

  it("drops what is not an opaque id from a waiting report", () => {
    const raw = JSON.stringify({
      tenantId: DEMO_TENANT_ID,
      deviceId: "client-1",
      report: { ...report(), ownerTenantUserId: "Cat Carer", locationIds: ["Harbour Lodge", HOME] },
    });
    expect(parsePendingReport(raw)).toEqual({
      tenantId: DEMO_TENANT_ID,
      report: { ...report(), heldSince: null, locationIds: [HOME] },
    });
  });
});

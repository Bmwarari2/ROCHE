import { SyncRefusedEntry } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import { all, openLocalDatabase } from "../test-support/local-db";
import { recordUploadIssue } from "./connector";
import type { ApiOptions } from "./discards";
import {
  copyCode,
  flushRefusedCopies,
  sendRefusedCopy,
  toRefusedCopy,
  type UploadIssueRow,
} from "./refused-copies";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_TENANT = "00000000-0000-4000-8000-0000000000a2";
const PERSON = "00000000-0000-4000-8000-0000000000b1";
const DEVICE = "00000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-10-11T15:00:00.000Z");
const ENTRY = "0199d000-0000-7000-8000-000000000001";

const row = (overrides: Partial<UploadIssueRow> = {}): UploadIssueRow => ({
  id: ENTRY,
  tenant_id: TENANT,
  person_id: PERSON,
  record_table: "care_note",
  http_status: 422,
  code: "care_event_after_exit",
  message: "The person had left before this was recorded.",
  payload: JSON.stringify({
    person_id: PERSON,
    category: "personal_care",
    body: "Settled; checked at 03:00.",
    occurred_at: "2026-10-11T03:00:00.000Z",
  }),
  rejected_at: "2026-10-11T14:59:00.000Z",
  ...overrides,
});

function fakeFetch(statuses: Array<number | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = statuses.shift();
    if (next === undefined) throw new Error("No more fake responses");
    if (next instanceof Error) throw next;
    return new Response(next < 300 ? '{"id":"x"}' : "{}", {
      status: next,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const options = (fetch: FetchLike): ApiOptions => ({
  apiUrl: API,
  fetch,
  token: "tok",
  tenantId: TENANT,
  deviceId: DEVICE,
});

describe("hazard HZ-006 a refused entry's copy, as the API takes it (care.md section 6, Device integrity part 5)", () => {
  it("sends the entry's content, the refusal and when, checked against the API's own schema", () => {
    const copy = toRefusedCopy(row(), NOW);
    if (copy.kind !== "copy") throw new Error("expected a copy");
    expect(SyncRefusedEntry.parse(copy.body)).toEqual(copy.body);
    expect(copy.body).toMatchObject({
      entryId: ENTRY,
      table: "care_note",
      personId: PERSON,
      httpStatus: 422,
      code: "care_event_after_exit",
      refusedAt: "2026-10-11T14:59:00.000Z",
    });
    // The request the device made for the note, as the API's own contract for notes has it.
    expect((copy.body.payload as { body?: string }).body).toBe("Settled; checked at 03:00.");
  });

  it("sends a refusal the device made before sending, and a code it does not know, as codes", () => {
    const copy = toRefusedCopy(
      row({ http_status: null, code: "Missing Field!", rejected_at: "not a time" }),
      NOW,
    );
    if (copy.kind !== "copy") throw new Error("expected a copy");
    expect(SyncRefusedEntry.parse(copy.body)).toMatchObject({
      httpStatus: null,
      code: "missing_field_",
      refusedAt: NOW.toISOString(),
    });
    expect(copyCode(null)).toBe("refused");
  });

  it.each([
    ["an entry a deletion that did not finish left", { code: "held_discard_failed" }],
    ["a change to a table the device never writes", { record_table: "person" }],
  ])("never sends %s", (_case, overrides) => {
    expect(toRefusedCopy(row(overrides), NOW)).toEqual({ kind: "skip" });
  });

  it.each([
    ["a refusal whose id is not an entry id", { id: "refused-0" }],
    ["an entry with no time, which is no valid request", { payload: "{}" }],
  ])(
    "hazard HZ-006 reports %s as one the server cannot keep (#25 review round 2, M2)",
    (_case, overrides) => {
      expect(toRefusedCopy(row(overrides), NOW)).toEqual({ kind: "unbuildable" });
    },
  );

  it.each([
    [201, "copied"],
    [200, "copied"],
    [422, "refused"],
    [413, "refused"],
    [401, "retry"],
    [403, "retry"],
    [429, "retry"],
    [503, "retry"],
  ] as const)("reads a %i as %s", async (status, expected) => {
    const copy = toRefusedCopy(row(), NOW);
    if (copy.kind !== "copy") throw new Error("expected a copy");
    expect(await sendRefusedCopy(options(fakeFetch([status]).fetch), copy.body)).toBe(expected);
  });

  it("waits on a network failure, never throwing", async () => {
    const copy = toRefusedCopy(row(), NOW);
    if (copy.kind !== "copy") throw new Error("expected a copy");
    expect(
      await sendRefusedCopy(options(fakeFetch([new TypeError("offline")]).fetch), copy.body),
    ).toBe("retry");
  });
});

describe("hazard HZ-006 sending refusals' copies after each sync until the server has them", () => {
  async function deviceWith(rows: UploadIssueRow[]) {
    const sql = await openLocalDatabase();
    const db = {
      execute: async (query: string, params: unknown[] = []) =>
        sql.prepare(query).run(...(params as never[])),
      getAll: async <T>(query: string, params: unknown[] = []) => all<T>(sql, query, params),
    };
    for (const r of rows) {
      await recordUploadIssue(db as unknown as Parameters<typeof recordUploadIssue>[0], {
        id: r.id,
        tenantId: r.tenant_id,
        personId: r.person_id,
        table: r.record_table ?? "",
        httpStatus: r.http_status,
        code: r.code ?? "",
        message: r.message ?? "",
        payload: JSON.parse(r.payload ?? "{}") as Record<string, unknown>,
        rejectedAt: new Date(r.rejected_at ?? NOW.toISOString()),
      });
    }
    const states = () =>
      all<{ id: string; server_copy: string | null }>(
        sql,
        "SELECT id, server_copy FROM upload_issue ORDER BY id",
        [],
      );
    return { db, states };
  }

  it("sends each refusal once, marks it, and keeps the entry on the device", async () => {
    const second = "0199d000-0000-7000-8000-000000000002";
    const third = "0199d000-0000-7000-8000-000000000003";
    const { db, states } = await deviceWith([
      row(),
      row({ id: second, rejected_at: "2026-10-11T14:59:30.000Z" }),
      row({ id: third, code: "held_discard_failed", rejected_at: "2026-10-11T14:59:40.000Z" }),
    ]);
    const { fetch, calls } = fakeFetch([201, 422]);
    expect(await flushRefusedCopies(db, options(fetch), NOW)).toBe(1);
    expect(states()).toEqual([
      { id: ENTRY, server_copy: "copied" },
      { id: second, server_copy: "refused" },
      { id: third, server_copy: "not_copied" },
    ]);
    // Sent with the session, the organisation and the device.
    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.url).toBe(`${API}/v1/sync/refused-entries`);
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(headers.get("x-harbour-tenant")).toBe(TENANT);
    expect(headers.get("x-harbour-device")).toBe(DEVICE);
    // Nothing is sent again.
    expect(await flushRefusedCopies(db, options(fakeFetch([]).fetch), NOW)).toBe(0);
  });

  it("stops at the first copy that must wait, and sends it again at the next sync", async () => {
    const { db, states } = await deviceWith([row()]);
    expect(await flushRefusedCopies(db, options(fakeFetch([503]).fetch), NOW)).toBe(0);
    expect(states()).toEqual([{ id: ENTRY, server_copy: null }]);
    expect(await flushRefusedCopies(db, options(fakeFetch([201]).fetch), NOW)).toBe(1);
    expect(states()).toEqual([{ id: ENTRY, server_copy: "copied" }]);
  });

  it("sends only the session's organisation's refusals", async () => {
    const { db, states } = await deviceWith([row({ tenant_id: OTHER_TENANT })]);
    expect(await flushRefusedCopies(db, options(fakeFetch([]).fetch), NOW)).toBe(0);
    expect(states()).toEqual([{ id: ENTRY, server_copy: null }]);
  });

  it("sends a refusal again when the same entry is refused again", async () => {
    const { db, states } = await deviceWith([row()]);
    await flushRefusedCopies(db, options(fakeFetch([201]).fetch), NOW);
    await recordUploadIssue(db as unknown as Parameters<typeof recordUploadIssue>[0], {
      id: ENTRY,
      tenantId: TENANT,
      personId: PERSON,
      table: "care_note",
      httpStatus: 422,
      code: "invalid",
      message: "Some details need checking.",
      payload: {},
      rejectedAt: NOW,
    });
    expect(states()).toEqual([{ id: ENTRY, server_copy: null }]);
  });
});

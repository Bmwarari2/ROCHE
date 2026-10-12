import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import {
  type CrudEntryLike,
  classifyUploadError,
  DEVICE_HEADER,
  DeviceRevokedError,
  HarbourConnector,
  parseSyncCredentials,
  readProblem,
  SENT_AT_HEADER,
  SessionRevokedError,
  TENANT_HEADER,
  toUploadOperation,
  UploadRejectedError,
  type UploadSource,
} from "./connector";

const API = "https://api.example.invalid";
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const PERSON = "00000000-0000-4000-8000-0000000000b1";

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("No more fake responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A 403 the edge or a proxy might send: no JSON problem body. */
const emptyForbidden = () => new Response("", { status: 403 });
const wafForbidden = () =>
  new Response("<html><body>Request blocked.</body></html>", {
    status: 403,
    headers: { "content-type": "text/html" },
  });

const problem = (status: number, code: string, title: string, detail?: string) =>
  json({ type: "about:blank", status, code, title, ...(detail ? { detail } : {}) }, status);

/** A fake PowerSync queue holding one transaction, recording local SQL (upload_issue writes). */
function fakeQueue(entries: CrudEntryLike[] | null) {
  const state = { completed: 0, sql: [] as Array<{ sql: string; params: unknown[] }> };
  const source = {
    getClientId: async () => "client-1",
    execute: async (sql: string, params: unknown[] = []) => {
      state.sql.push({ sql, params });
      return { rowsAffected: 1 };
    },
    getNextCrudTransaction: async () =>
      entries
        ? {
            crud: entries,
            transactionId: 42,
            haveMore: false,
            complete: async () => {
              state.completed += 1;
            },
          }
        : null,
  } as unknown as UploadSource;
  const issues = () =>
    state.sql
      .filter((s) => s.sql.startsWith("INSERT INTO upload_issue"))
      .map((s) => ({
        id: s.params[0],
        tenantId: s.params[1],
        personId: s.params[2],
        table: s.params[3],
        httpStatus: s.params[4],
        code: s.params[5],
        message: s.params[6],
        payload: JSON.parse(String(s.params[7])) as Record<string, unknown>,
      }));
  return { source, state, issues };
}

/** `GET /v1/me` answering with the permission Care mode needs: the session stands. */
const meOk = () => json({ permissions: ["people.person.read", "care.note.write"] });
/** `GET /v1/me` answering without it: the access Care mode needs has been withdrawn. */
const meWithdrawn = () => json({ permissions: ["care.note.write"] });
const edgeBlocked = () => problem(403, "edge_blocked", "Request blocked.");

function connector(
  fetch: FetchLike,
  overrides: { token?: string | null; now?: () => Date; tenantId?: string | null } = {},
) {
  const revoked = { count: 0, device: 0 };
  const sleeps: number[] = [];
  const instance = new HarbourConnector({
    apiUrl: API,
    fetch,
    getToken: async () => (overrides.token === undefined ? "tok" : overrides.token),
    getTenantId: () => (overrides.tenantId === undefined ? TENANT : overrides.tenantId),
    onSessionRevoked: () => {
      revoked.count += 1;
    },
    onDeviceRevoked: () => {
      revoked.device += 1;
    },
    backoff: { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3 },
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: overrides.now ?? (() => new Date("2026-10-11T15:00:00.000Z")),
  });
  return { instance, revoked, sleeps };
}

/** A note written offline at 09:00 by the device clock. */
const note = (id = "0199d000-0000-7000-8000-000000000001"): CrudEntryLike => ({
  op: "PUT",
  table: "care_note",
  id,
  opData: {
    tenant_id: TENANT,
    person_id: PERSON,
    location_id: "loc",
    category: "personal_care",
    body: "Helped with a wash; skin intact.",
    tags: '["refusal"]',
    occurred_at: "2026-10-11T08:55:00.000Z",
    device_time: "2026-10-11T09:00:00.000Z",
    supersedes_id: null,
    correction_reason: null,
  },
});

/** A table the device never writes, which goes through /v1/sync/upload. */
const other: CrudEntryLike = { op: "PUT", table: "person", id: "p1", opData: { given_name: "X" } };

describe("toUploadOperation", () => {
  it("maps PUT, PATCH and DELETE entries to the upload contract", () => {
    expect(toUploadOperation(other)).toEqual({
      op: "PUT",
      table: "person",
      id: "p1",
      data: { given_name: "X" },
    });
    expect(toUploadOperation({ op: "PATCH", table: "t", id: "1", opData: { a: 1 } }).data).toEqual({
      a: 1,
    });
    expect(toUploadOperation({ op: "DELETE", table: "t", id: "1" })).toEqual({
      op: "DELETE",
      table: "t",
      id: "1",
      data: {},
    });
  });

  it("refuses unknown operations", () => {
    expect(() => toUploadOperation({ op: "MERGE", table: "t", id: "1" })).toThrow(/Unsupported/);
  });
});

describe("parseSyncCredentials", () => {
  it("accepts the contract shape", () => {
    expect(
      parseSyncCredentials({
        token: "jwt",
        endpoint: "https://sync.example.invalid",
        expiresAt: "2026-10-09T14:00:00Z",
      }),
    ).toEqual({
      token: "jwt",
      endpoint: "https://sync.example.invalid",
      expiresAt: new Date("2026-10-09T14:00:00Z"),
    });
  });

  it.each([null, {}, { token: "", endpoint: "https://x" }, { token: "t", endpoint: "ftp://x" }])(
    "rejects %j",
    (value) => {
      expect(() => parseSyncCredentials(value)).toThrow();
    },
  );
});

describe("fetchCredentials", () => {
  it("exchanges the session for PowerSync credentials", async () => {
    const { fetch, calls } = fakeFetch([
      json({
        token: "jwt",
        endpoint: "https://sync.example.invalid",
        expiresAt: "2026-10-09T14:00:00Z",
      }),
    ]);
    const { instance } = connector(fetch);
    await expect(instance.fetchCredentials()).resolves.toMatchObject({ token: "jwt" });
    expect(calls[0]?.url).toBe(`${API}/v1/sync/token`);
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(calls[0]?.init?.headers).get(TENANT_HEADER)).toBe(TENANT);
    // No device id given: none is sent.
    expect(new Headers(calls[0]?.init?.headers).has(DEVICE_HEADER)).toBe(false);
  });

  it("hazard HZ-040 names the device when it asks for credentials, so the server knows who has used it (security review round 7, M1)", async () => {
    const credentials = {
      token: "jwt",
      endpoint: "https://sync.example.invalid",
      expiresAt: "2026-10-09T14:00:00Z",
    };
    const { fetch, calls } = fakeFetch([json(credentials), json(credentials)]);
    const named = new HarbourConnector({
      apiUrl: API,
      fetch,
      getToken: async () => "tok",
      getTenantId: () => TENANT,
      getDeviceId: async () => "0199d000-0000-4000-8000-00000000de01",
      onSessionRevoked: () => undefined,
    });
    await named.fetchCredentials();
    expect(new Headers(calls[0]?.init?.headers).get(DEVICE_HEADER)).toBe(
      "0199d000-0000-4000-8000-00000000de01",
    );
    // A device id that cannot be read sends none, and the credentials still come.
    const unreadable = new HarbourConnector({
      apiUrl: API,
      fetch,
      getToken: async () => "tok",
      getTenantId: () => TENANT,
      getDeviceId: async () => {
        throw new Error("keystore unavailable");
      },
      onSessionRevoked: () => undefined,
    });
    await expect(unreadable.fetchCredentials()).resolves.toMatchObject({ token: "jwt" });
    expect(new Headers(calls[1]?.init?.headers).has(DEVICE_HEADER)).toBe(false);
  });

  it("does not connect when signed out", async () => {
    const { fetch, calls } = fakeFetch([]);
    const { instance } = connector(fetch, { token: null });
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("treats a 401 as an ended session and reports it for the hold-or-wipe rule", async () => {
    const { fetch } = fakeFetch([json({}, 401)]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    expect(revoked.count).toBe(1);
  });

  it.each(["not_a_member", "mfa_enrolment_required", "step_up_required"])(
    "hazard HZ-006 treats a 403 %s from the sync token as an ended session",
    async (code) => {
      const { fetch, calls } = fakeFetch([problem(403, code, "Session problem.")]);
      const { instance, revoked } = connector(fetch);
      await expect(instance.fetchCredentials()).resolves.toBeNull();
      expect(revoked.count).toBe(1);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    ["missing_permission", () => problem(403, "missing_permission", "No access.")],
    ["feature_disabled", () => problem(403, "feature_disabled", "Switched off.")],
    ["an unknown code", () => problem(403, "a_code_this_build_does_not_know", "No.")],
  ])(
    "hazard HZ-006 treats a 403 %s from the sync token as access withdrawn, without asking /v1/me (round 4, H1)",
    async (_case, forbidden) => {
      const { fetch, calls } = fakeFetch([forbidden()]);
      const { instance, revoked } = connector(fetch);
      await expect(instance.fetchCredentials()).resolves.toBeNull();
      expect(revoked.count).toBe(1);
      expect(calls).toHaveLength(1);
    },
  );

  it.each([
    ["no JSON body", emptyForbidden],
    ["a WAF HTML page", wafForbidden],
    ["the edge's edge_blocked", edgeBlocked],
  ])(
    "hazard HZ-006 backs off on a 403 from the sync token with %s while /v1/me answers (H1)",
    async (_case, forbidden) => {
      const { fetch, calls } = fakeFetch([forbidden(), meOk()]);
      const { instance, revoked } = connector(fetch);
      await expect(instance.fetchCredentials()).rejects.toMatchObject({ status: 403 });
      expect(revoked.count).toBe(0);
      expect(calls[1]?.url).toBe(`${API}/v1/me`);
      const probe = new Headers(calls[1]?.init?.headers);
      expect(probe.get("authorization")).toBe("Bearer tok");
      expect(probe.get(TENANT_HEADER)).toBe(TENANT);
    },
  );

  it("ends the session after an unexplained 403 only when /v1/me says so", async () => {
    const { fetch } = fakeFetch([wafForbidden(), json({}, 401)]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    expect(revoked.count).toBe(1);
  });

  it("hazard HZ-006 ends the session when /v1/me answers without the access Care mode needs (round 4, H1)", async () => {
    const { fetch } = fakeFetch([edgeBlocked(), meWithdrawn()]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    expect(revoked.count).toBe(1);
  });

  it("backs off when /v1/me answers with something it cannot read", async () => {
    const { fetch } = fakeFetch([emptyForbidden(), json({}, 200)]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).rejects.toMatchObject({ status: 403 });
    expect(revoked.count).toBe(0);
  });

  it("sends no organisation header when the session has none", async () => {
    const { fetch, calls } = fakeFetch([emptyForbidden(), meOk()]);
    const { instance } = connector(fetch, { tenantId: null });
    await expect(instance.fetchCredentials()).rejects.toMatchObject({ status: 403 });
    expect(new Headers(calls[0]?.init?.headers).get(TENANT_HEADER)).toBeNull();
    expect(new Headers(calls[1]?.init?.headers).get(TENANT_HEADER)).toBeNull();
  });

  it("throws on server errors so PowerSync retries the connection", async () => {
    const { fetch } = fakeFetch([json({}, 503)]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).rejects.toMatchObject({ status: 503 });
    expect(revoked.count).toBe(0);
  });
});

describe("uploadData: care entries go to their own endpoints", () => {
  it("does nothing when the queue is empty", async () => {
    const { fetch, calls } = fakeFetch([]);
    const { instance } = connector(fetch);
    await instance.uploadData(fakeQueue(null).source);
    expect(calls).toHaveLength(0);
  });

  it("hazard HZ-010 hazard HZ-017 sends the time it was written and the time it was sent apart", async () => {
    const { fetch, calls } = fakeFetch([json({}, 201)]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([note()]);
    await instance.uploadData(queue.source);

    expect(calls[0]?.url).toBe(`${API}/v1/people/${PERSON}/notes`);
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = new Headers(calls[0]?.init?.headers);
    // Sent at 15:00 by the device clock: the server measures drift from this.
    expect(headers.get(SENT_AT_HEADER)).toBe("2026-10-11T15:00:00.000Z");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.get(DEVICE_HEADER)).toBe("client-1");
    expect(headers.get("idempotency-key")).toBe("0199d000-0000-7000-8000-000000000001");
    expect(headers.get("authorization")).toBe("Bearer tok");
    // Written at 09:00 for an event at 08:55: not late, even though it uploaded six hours later.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      id: "0199d000-0000-7000-8000-000000000001",
      occurredAt: "2026-10-11T08:55:00.000Z",
      deviceTime: "2026-10-11T09:00:00.000Z",
      category: "personal_care",
      body: "Helped with a wash; skin intact.",
      tags: ["refusal"],
      attachmentDocumentIds: [],
    });
    expect(queue.state.completed).toBe(1);
  });

  it("hazard HZ-010 stamps each retry with the time it is sent", async () => {
    const times = ["2026-10-11T15:00:00.000Z", "2026-10-11T15:00:05.000Z"];
    const { fetch, calls } = fakeFetch([json({}, 503), json({}, 201)]);
    const { instance } = connector(fetch, { now: () => new Date(times.shift() ?? "") });
    await instance.uploadData(fakeQueue([note()]).source);
    const sent = calls.map((c) => new Headers(c.init?.headers).get(SENT_AT_HEADER));
    expect(sent).toEqual(["2026-10-11T15:00:00.000Z", "2026-10-11T15:00:05.000Z"]);
    // The same id both times, so the API keeps one note.
    const ids = calls.map((c) => JSON.parse(String(c.init?.body)).id);
    expect(new Set(ids).size).toBe(1);
  });

  it("treats the API's answer to a replayed id as success", async () => {
    // The first response was lost after the API saved the note; the replay returns the saved copy.
    const { fetch, calls } = fakeFetch([new TypeError("Network request failed"), json({}, 201)]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([note()]);
    await instance.uploadData(queue.source);
    expect(calls).toHaveLength(2);
    expect(queue.state.completed).toBe(1);
    expect(queue.issues()).toEqual([]);
  });

  it.each([
    [
      "observation",
      "observations",
      { chart_values: '{"chart":"weight","kg":61.2,"method":"chair"}' },
    ],
    [
      "body_map_mark",
      "body-map",
      { view: "front", region: "shin", side: "left", drawn_side: "left", mark_type: "rash" },
    ],
    [
      "activity_record",
      "activities",
      { activity: "Gardening", format: "one_to_one", attendance: "attended" },
    ],
    ["visit_log", "visits", { kind: "facilitated_visit", visitor_name: "Invented visitor" }],
  ])("sends %s to /%s", async (table, path, data) => {
    const { fetch, calls } = fakeFetch([json({}, 201)]);
    const { instance } = connector(fetch);
    const entry = note();
    await instance.uploadData(
      fakeQueue([{ ...entry, table, opData: { ...entry.opData, ...data } }]).source,
    );
    expect(calls[0]?.url).toBe(`${API}/v1/people/${PERSON}/${path}`);
  });

  it("hazard HZ-006 moves a refused entry to needs attention with its content, and the queue moves on", async () => {
    const { fetch, calls } = fakeFetch([
      problem(
        422,
        "invalid",
        "Some details need checking.",
        "This person's record is closed; only post-event notes can be added.",
      ),
      json({}, 201),
    ]);
    const { instance } = connector(fetch);
    const second = note("0199d000-0000-7000-8000-000000000002");
    const queue = fakeQueue([note(), second]);
    await instance.uploadData(queue.source);

    expect(calls).toHaveLength(2);
    expect(queue.state.completed).toBe(1);
    expect(queue.issues()).toEqual([
      {
        id: "0199d000-0000-7000-8000-000000000001",
        tenantId: TENANT,
        personId: PERSON,
        table: "care_note",
        httpStatus: 422,
        code: "invalid",
        message: "This person's record is closed; only post-event notes can be added.",
        payload: note().opData,
      },
    ]);
  });

  it("hazard HZ-006 keeps a refusal for a missing permission on the device, without wiping it", async () => {
    const { fetch } = fakeFetch([
      problem(403, "missing_permission", "You do not have access to this."),
      json({}, 200),
    ]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([note()]);
    await instance.uploadData(queue.source);
    expect(revoked.count).toBe(0);
    expect(queue.issues()[0]).toMatchObject({
      code: "missing_permission",
      message: "You do not have access to this.",
    });
  });

  it.each([
    ["missing_permission", () => problem(403, "missing_permission", "Refused.")],
    ["feature_disabled", () => problem(403, "feature_disabled", "Refused.")],
    ["an unknown code", () => problem(403, "a_code_this_build_does_not_know", "Refused.")],
  ])(
    "hazard HZ-006 parks the entry the API refused with %s, never the session",
    async (_case, forbidden) => {
      const { fetch, calls } = fakeFetch([forbidden()]);
      const { instance, revoked } = connector(fetch);
      const queue = fakeQueue([note()]);
      await instance.uploadData(queue.source);
      expect(revoked.count).toBe(0);
      expect(calls).toHaveLength(1);
      expect(queue.issues()).toHaveLength(1);
      expect(queue.state.completed).toBe(1);
    },
  );

  it.each([
    ["no JSON body", emptyForbidden],
    ["a WAF HTML page", wafForbidden],
    ["the edge's edge_blocked", edgeBlocked],
  ])(
    "hazard HZ-006 parks the entry, never the session, on a 403 with %s while /v1/me answers (H1)",
    async (_case, forbidden) => {
      const { fetch, calls } = fakeFetch([forbidden(), meOk()]);
      const { instance, revoked } = connector(fetch);
      const queue = fakeQueue([note()]);
      await instance.uploadData(queue.source);
      expect(revoked.count).toBe(0);
      expect(calls[1]?.url).toBe(`${API}/v1/me`);
      expect(new Headers(calls[1]?.init?.headers).get(TENANT_HEADER)).toBe(TENANT);
      expect(queue.issues()).toHaveLength(1);
      expect(queue.state.completed).toBe(1);
    },
  );

  it("hazard HZ-006 ends the session on an unexplained 403 when /v1/me lacks the access Care mode needs (round 4, H1)", async () => {
    const { fetch } = fakeFetch([edgeBlocked(), meWithdrawn()]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([note()]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(revoked.count).toBe(1);
    expect(queue.issues()).toEqual([]);
    expect(queue.state.completed).toBe(0);
  });

  it("hazard HZ-006 keeps the entry queued on an unexplained 403 when /v1/me cannot be reached", async () => {
    const { fetch } = fakeFetch([wafForbidden(), new TypeError("Network request failed")]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([note()]);
    await expect(instance.uploadData(queue.source)).rejects.toMatchObject({ status: 403 });
    expect(revoked.count).toBe(0);
    expect(queue.issues()).toEqual([]);
    expect(queue.state.completed).toBe(0);
  });

  it.each(["not_a_member", "mfa_enrolment_required", "step_up_required"])(
    "hazard HZ-006 ends the session on a 403 %s instead of parking the entry as refused",
    async (code) => {
      const { fetch, calls } = fakeFetch([problem(403, code, "Session problem.")]);
      const { instance, revoked } = connector(fetch);
      const queue = fakeQueue([note()]);
      await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(SessionRevokedError);
      expect(revoked.count).toBe(1);
      expect(calls).toHaveLength(1);
      expect(queue.issues()).toEqual([]);
      expect(queue.state.completed).toBe(0);
    },
  );

  it("hazard HZ-006 ends the session on an unexplained 403 when /v1/me says 401", async () => {
    const { fetch } = fakeFetch([emptyForbidden(), json({}, 401)]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([note()]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(revoked.count).toBe(1);
    expect(queue.issues()).toEqual([]);
  });

  it("refuses to send a change to an append-only entry and keeps it for attention", async () => {
    const { fetch, calls } = fakeFetch([]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([{ ...note(), op: "PATCH" }]);
    await instance.uploadData(queue.source);
    expect(calls).toHaveLength(0);
    expect(queue.issues()[0]).toMatchObject({ code: "entry_not_editable", httpStatus: null });
    expect(queue.state.completed).toBe(1);
  });

  it("refuses an entry without its person rather than sending it anywhere", async () => {
    const { fetch, calls } = fakeFetch([]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([{ ...note(), opData: { ...note().opData, person_id: null } }]);
    await instance.uploadData(queue.source);
    expect(calls).toHaveLength(0);
    expect(queue.issues()[0]).toMatchObject({ code: "entry_incomplete" });
  });

  it("keeps entries queued when the network stays down", async () => {
    const { fetch, calls } = fakeFetch([json({}, 500), json({}, 502), json({}, 504)]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([note()]);
    await expect(instance.uploadData(queue.source)).rejects.toMatchObject({ status: 504 });
    expect(calls).toHaveLength(3);
    expect(queue.state.completed).toBe(0);
    expect(queue.issues()).toEqual([]);
  });

  it("stops and reports the ended session, leaving the entry queued", async () => {
    const { fetch } = fakeFetch([json({}, 401)]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([note()]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(revoked.count).toBe(1);
    expect(queue.state.completed).toBe(0);
  });
});

describe("uploadData: other tables through /v1/sync/upload", () => {
  it("uploads the transaction with an idempotency key and the time it was sent", async () => {
    const { fetch, calls } = fakeFetch([json({ applied: 2, rejected: [] })]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([other, { op: "DELETE", table: "person", id: "p2" }]);
    await instance.uploadData(queue.source);
    expect(calls[0]?.url).toBe(`${API}/v1/sync/upload`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("idempotency-key")).toBe("client-1:42");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      operations: [
        {
          op: "PUT",
          table: "person",
          id: "p1",
          data: { given_name: "X" },
          deviceSentAt: "2026-10-11T15:00:00.000Z",
        },
        {
          op: "DELETE",
          table: "person",
          id: "p2",
          data: {},
          deviceSentAt: "2026-10-11T15:00:00.000Z",
        },
      ],
    });
    expect(queue.state.completed).toBe(1);
  });

  it("retries network failures and 5xx with backoff before succeeding", async () => {
    const { fetch, calls } = fakeFetch([
      new TypeError("Network request failed"),
      json({}, 503),
      json({ applied: 1, rejected: [] }),
    ]);
    const { instance, sleeps } = connector(fetch);
    const queue = fakeQueue([other]);
    await instance.uploadData(queue.source);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]);
    expect(queue.state.completed).toBe(1);
  });

  it("honours Retry-After on 429", async () => {
    const { fetch } = fakeFetch([
      json({}, 429, { "retry-after": "1" }),
      json({ applied: 1, rejected: [] }),
    ]);
    const { instance, sleeps } = connector(fetch);
    await instance.uploadData(fakeQueue([other]).source);
    expect(sleeps).toEqual([1000]);
  });

  it("hazard HZ-006 never completes an operation the API refused inside a 200", async () => {
    const { fetch } = fakeFetch([
      json({
        applied: 0,
        rejected: [
          {
            id: "p1",
            code: "table_not_writable",
            message: "This kind of record cannot be changed from a device yet.",
          },
        ],
      }),
    ]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([other]);
    await instance.uploadData(queue.source);
    expect(queue.issues()).toEqual([
      expect.objectContaining({
        id: "p1",
        code: "table_not_writable",
        message: "This kind of record cannot be changed from a device yet.",
        payload: { given_name: "X" },
      }),
    ]);
  });

  it("hazard HZ-006 never discards a refused write: it moves to needs attention", async () => {
    const { fetch, calls } = fakeFetch([json({ error: "conflict" }, 409)]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([other]);
    await instance.uploadData(queue.source);
    expect(calls).toHaveLength(1);
    expect(queue.issues()).toEqual([expect.objectContaining({ id: "p1", httpStatus: 409 })]);
    expect(queue.state.completed).toBe(1);
  });

  it.each([
    ["401", () => json({}, 401)],
    ["403 not_a_member", () => problem(403, "not_a_member", "Not a member.")],
    ["403 missing_permission", () => problem(403, "missing_permission", "No access.")],
    ["403 with an unknown code", () => problem(403, "a_code_this_build_does_not_know", "No.")],
  ])("stops and reports the ended session on %s (round 4, H1)", async (_case, response) => {
    const { fetch } = fakeFetch([response()]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([other]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(revoked.count).toBe(1);
    expect(queue.state.completed).toBe(0);
  });

  it.each([
    ["no JSON body", emptyForbidden],
    ["a WAF HTML page", wafForbidden],
    ["the edge's edge_blocked", edgeBlocked],
  ])(
    "backs off on a 403 with %s while /v1/me answers, never parking the batch (H1)",
    async (_case, forbidden) => {
      const { fetch } = fakeFetch([forbidden(), meOk()]);
      const { instance, revoked } = connector(fetch);
      const queue = fakeQueue([other]);
      await expect(instance.uploadData(queue.source)).rejects.toMatchObject({ status: 403 });
      expect(revoked.count).toBe(0);
      expect(queue.issues()).toEqual([]);
      expect(queue.state.completed).toBe(0);
    },
  );
});

describe("readProblem", () => {
  it("prefers the detail, then the title", async () => {
    await expect(readProblem(problem(422, "invalid", "Title", "Detail"))).resolves.toEqual({
      code: "invalid",
      reason: "Detail",
    });
    await expect(readProblem(problem(404, "not_found", "Not found"))).resolves.toEqual({
      code: "not_found",
      reason: "Not found",
    });
  });

  it("copes with a body that is not problem details", async () => {
    await expect(readProblem(new Response("<html>", { status: 400 }))).resolves.toEqual({
      code: "http_400",
      reason: null,
    });
  });
});

describe("classifyUploadError", () => {
  it("retries network errors and transient statuses only", () => {
    expect(classifyUploadError(new TypeError("Network request failed"))).toEqual({ retry: true });
    expect(classifyUploadError(new UploadRejectedError(422))).toEqual({ retry: false });
    expect(classifyUploadError(new SessionRevokedError())).toEqual({ retry: false });
  });
});

describe("hazard HZ-040 a device a manager revoked (care.md section 6, Device integrity part 2)", () => {
  const revokedProblem = () =>
    problem(403, "device_revoked", "This device has been withdrawn from Harbour by a manager.");

  it("reads device_revoked on the sync token as a revocation, never as an ended session or withdrawn access", async () => {
    const { fetch, calls } = fakeFetch([revokedProblem()]);
    const { instance, revoked } = connector(fetch);
    expect(await instance.fetchCredentials()).toBeNull();
    expect(revoked).toEqual({ count: 0, device: 1 });
    // Decided by the API: no need to ask GET /v1/me.
    expect(calls).toHaveLength(1);
  });

  it("keeps a care entry queued, never parked as refused, when the API says the device is revoked", async () => {
    const { fetch, calls } = fakeFetch([revokedProblem()]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([note()]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(queue.issues()).toEqual([]);
    expect(queue.state.completed).toBe(0);
    expect(revoked).toEqual({ count: 0, device: 1 });
    // Not retried: the device is told once.
    expect(calls).toHaveLength(1);
  });

  it("reads device_revoked on a batch upload as a revocation", async () => {
    const { fetch } = fakeFetch([revokedProblem()]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([other]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(DeviceRevokedError);
    expect(queue.issues()).toEqual([]);
    expect(revoked.device).toBe(1);
  });

  it("is an ended session for callers that know only that, so nothing is retried", () => {
    expect(new DeviceRevokedError()).toBeInstanceOf(SessionRevokedError);
    expect(classifyUploadError(new DeviceRevokedError())).toEqual({ retry: false });
  });
});

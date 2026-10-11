import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import {
  type CrudEntryLike,
  classifyUploadError,
  HarbourConnector,
  parseSyncCredentials,
  SessionRevokedError,
  toUploadOperation,
  UploadRejectedError,
  type UploadSource,
} from "./connector";

const API = "https://api.example.invalid";

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

function fakeQueue(entries: CrudEntryLike[] | null) {
  const state = { completed: 0 };
  const source = {
    getClientId: async () => "client-1",
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
  return { source, state };
}

function connector(fetch: FetchLike, overrides: { token?: string | null } = {}) {
  const revoked = { count: 0 };
  const sleeps: number[] = [];
  const instance = new HarbourConnector({
    apiUrl: API,
    fetch,
    getToken: async () => (overrides.token === undefined ? "tok" : overrides.token),
    onSessionRevoked: () => {
      revoked.count += 1;
    },
    backoff: { baseDelayMs: 100, maxDelayMs: 1000, maxAttempts: 3 },
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { instance, revoked, sleeps };
}

const put: CrudEntryLike = { op: "PUT", table: "care_note", id: "n1", opData: { body: "Text" } };

describe("toUploadOperation", () => {
  it("maps PUT, PATCH and DELETE entries to the upload contract", () => {
    expect(toUploadOperation(put)).toEqual({
      op: "PUT",
      table: "care_note",
      id: "n1",
      data: { body: "Text" },
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
  });

  it("does not connect when signed out", async () => {
    const { fetch, calls } = fakeFetch([]);
    const { instance } = connector(fetch, { token: null });
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it.each([401, 403])("treats %i as a revoked session and triggers the wipe", async (status) => {
    const { fetch } = fakeFetch([json({}, status)]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).resolves.toBeNull();
    expect(revoked.count).toBe(1);
  });

  it("throws on server errors so PowerSync retries the connection", async () => {
    const { fetch } = fakeFetch([json({}, 503)]);
    const { instance, revoked } = connector(fetch);
    await expect(instance.fetchCredentials()).rejects.toMatchObject({ status: 503 });
    expect(revoked.count).toBe(0);
  });
});

describe("uploadData", () => {
  it("does nothing when the queue is empty", async () => {
    const { fetch, calls } = fakeFetch([]);
    const { instance } = connector(fetch);
    await instance.uploadData(fakeQueue(null).source);
    expect(calls).toHaveLength(0);
  });

  it("uploads the transaction with an idempotency key, then completes it", async () => {
    const { fetch, calls } = fakeFetch([json({ ok: true })]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([put, { op: "DELETE", table: "care_note", id: "n2" }]);
    await instance.uploadData(queue.source);
    expect(calls[0]?.url).toBe(`${API}/v1/sync/upload`);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("idempotency-key")).toBe("client-1:42");
    expect(headers.get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      operations: [
        { op: "PUT", table: "care_note", id: "n1", data: { body: "Text" } },
        { op: "DELETE", table: "care_note", id: "n2", data: {} },
      ],
    });
    expect(queue.state.completed).toBe(1);
  });

  it("retries network failures and 5xx with backoff before succeeding", async () => {
    const { fetch, calls } = fakeFetch([
      new TypeError("Network request failed"),
      json({}, 503),
      json({ ok: true }),
    ]);
    const { instance, sleeps } = connector(fetch);
    const queue = fakeQueue([put]);
    await instance.uploadData(queue.source);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([50, 100]);
    expect(queue.state.completed).toBe(1);
  });

  it("honours Retry-After on 429", async () => {
    const { fetch } = fakeFetch([json({}, 429, { "retry-after": "1" }), json({ ok: true })]);
    const { instance, sleeps } = connector(fetch);
    await instance.uploadData(fakeQueue([put]).source);
    expect(sleeps).toEqual([1000]);
  });

  it("keeps the transaction queued when retries run out", async () => {
    const { fetch, calls } = fakeFetch([json({}, 500), json({}, 502), json({}, 504)]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([put]);
    await expect(instance.uploadData(queue.source)).rejects.toMatchObject({ status: 504 });
    expect(calls).toHaveLength(3);
    expect(queue.state.completed).toBe(0);
  });

  it("never discards a rejected write: it stays queued and the error surfaces", async () => {
    const { fetch, calls } = fakeFetch([json({ error: "conflict" }, 409)]);
    const { instance } = connector(fetch);
    const queue = fakeQueue([put]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(UploadRejectedError);
    expect(calls).toHaveLength(1);
    expect(queue.state.completed).toBe(0);
  });

  it("stops and triggers the wipe when the session was revoked", async () => {
    const { fetch } = fakeFetch([json({}, 401)]);
    const { instance, revoked } = connector(fetch);
    const queue = fakeQueue([put]);
    await expect(instance.uploadData(queue.source)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(revoked.count).toBe(1);
    expect(queue.state.completed).toBe(0);
  });
});

describe("classifyUploadError", () => {
  it("retries network errors and transient statuses only", () => {
    expect(classifyUploadError(new TypeError("Network request failed"))).toEqual({ retry: true });
    expect(classifyUploadError(new UploadRejectedError(422))).toEqual({ retry: false });
    expect(classifyUploadError(new SessionRevokedError())).toEqual({ retry: false });
  });
});

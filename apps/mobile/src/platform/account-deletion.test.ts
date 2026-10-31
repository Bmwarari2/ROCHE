import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../auth/http";
import { t } from "../i18n/t";
import { type DeletionOutcome, deletionMessage, requestAccountDeletion } from "./account-deletion";

/**
 * "Delete my account" (MOB-011): the request goes to the care provider through the API; nothing
 * is deleted by asking; every outcome is said in words.
 */

const TENANT = "0194d000-0000-7000-8000-000000000001";
const ORG = "Harbour Demo Care";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const deps = (fetch: ReturnType<typeof vi.fn>, demoMode = false) => ({
  apiUrl: "https://api.harbour.example.invalid",
  fetch: fetch as unknown as FetchLike,
  token: "token-1",
  tenantId: TENANT,
  demoMode,
});

describe("requestAccountDeletion", () => {
  it("posts to the organisation's request route with the session and tenant, and no body", async () => {
    const fetch = vi.fn(async () =>
      json(201, {
        status: "requested",
        requestedAt: "2026-10-31T10:00:00.000Z",
        respondBy: "2026-11-30T10:00:00.000Z",
        routedToManager: true,
      }),
    );
    const outcome = await requestAccountDeletion(deps(fetch));
    expect(outcome).toEqual({
      kind: "requested",
      respondBy: "2026-11-30T10:00:00.000Z",
      routedToManager: true,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.harbour.example.invalid/v1/me/account-deletion-request");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({
      Authorization: "Bearer token-1",
      "x-harbour-tenant": TENANT,
    });
  });

  it.each([
    ["no connection", () => Promise.reject(new TypeError("Network request failed")), "offline"],
    ["a busy server", async () => json(503, {}), "server"],
    ["too many requests", async () => json(429, {}), "server"],
    ["an ended session", async () => json(401, { code: "unauthenticated" }), "session"],
    [
      "a refusal",
      async () =>
        json(403, { code: "missing_permission", title: "No", detail: "Ask your manager." }),
      "refused",
    ],
    ["an unreadable answer", async () => json(200, { status: "weird" }), "refused"],
  ])("says %s as %s", async (_, answer, kind) => {
    const outcome = await requestAccountDeletion(deps(vi.fn(answer)));
    expect(outcome.kind).toBe(kind);
  });

  it("sends nothing in demo mode", async () => {
    const fetch = vi.fn();
    expect(await requestAccountDeletion(deps(fetch, true))).toEqual({ kind: "demo" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("deletionMessage", () => {
  const at = "2026-11-30T10:00:00.000Z";
  it.each<[DeletionOutcome, string, string, boolean]>([
    [
      { kind: "requested", respondBy: at, routedToManager: true },
      "Request sent",
      "We have asked Harbour Demo Care to reply by 30/11/2026. You can keep using Harbour until then.",
      true,
    ],
    [
      { kind: "already_requested", respondBy: at, routedToManager: true },
      "Already asked",
      "You asked before. We have asked Harbour Demo Care to reply by 30/11/2026.",
      true,
    ],
    [
      { kind: "requested", respondBy: at, routedToManager: false },
      "Request kept, not yet seen",
      "Your request is kept, but no one at Harbour Demo Care manages accounts in Harbour yet. Tell your manager you have asked.",
      true,
    ],
    [
      { kind: "demo" },
      "Demo mode: not sent",
      "Demo mode: nothing is sent. In the real app this asks your organisation to delete your account.",
      false,
    ],
    [
      { kind: "offline" },
      "Request not sent",
      "There is no connection. Try again when you are online.",
      false,
    ],
    [
      { kind: "server" },
      "Request not sent",
      "Harbour could not reach the server. Try again later.",
      false,
    ],
    [
      { kind: "session" },
      "Request not sent",
      "Your session has ended. Sign in again, then ask again.",
      false,
    ],
    [
      { kind: "refused", reason: "Ask your manager." },
      "Request not sent",
      "Ask your manager.",
      false,
    ],
    [
      { kind: "refused", reason: null },
      "Request not sent",
      "Harbour could not send it. Try again later.",
      false,
    ],
  ])("says %j in words with a title that matches", (outcome, title, body, sent) => {
    const message = deletionMessage(outcome, ORG, t);
    expect(message).toEqual({ title, body, sent });
  });

  it("says 'your organisation' when the name is not known, never a blank", () => {
    const message = deletionMessage(
      { kind: "requested", respondBy: at, routedToManager: true },
      "  ",
      t,
    );
    expect(message.body).toBe(
      "We have asked your organisation to reply by 30/11/2026. You can keep using Harbour until then.",
    );
  });
});

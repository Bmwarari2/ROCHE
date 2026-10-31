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
    ["a busy server", async () => json(503, {}), "offline"],
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
  it.each<[DeletionOutcome, string, boolean]>([
    [
      { kind: "requested", respondBy: "2026-11-30T10:00:00.000Z", routedToManager: true },
      "Harbour Demo Care is asked to confirm by 30/11/2026. You can keep using Harbour until then.",
      true,
    ],
    [
      { kind: "already_requested", respondBy: "2026-11-30T10:00:00.000Z", routedToManager: true },
      "You have already asked. Harbour Demo Care is asked to confirm by 30/11/2026.",
      true,
    ],
    [
      { kind: "requested", respondBy: "2026-11-30T10:00:00.000Z", routedToManager: false },
      "Your request is kept, but no one at Harbour Demo Care manages accounts in Harbour yet. Tell your manager you have asked.",
      true,
    ],
    [{ kind: "offline" }, "There is no connection. Try again when you are online.", false],
    [{ kind: "session" }, "Your session has ended. Sign in again, then ask again.", false],
    [{ kind: "refused", reason: "Ask your manager." }, "Ask your manager.", false],
    [{ kind: "refused", reason: null }, "Harbour could not send it. Try again later.", false],
  ])("says %j in words", (outcome, body, sent) => {
    const message = deletionMessage(outcome, ORG, t);
    expect(message.body).toBe(body);
    expect(message.sent).toBe(sent);
    expect(message.title).toBe(sent ? "Request sent" : "Request not sent");
  });
});

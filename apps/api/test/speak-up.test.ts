import { createHash } from "node:crypto";
import type {
  AnonymousSpeakUpRaised,
  SpeakUpCaseDetail,
  SpeakUpCaseList,
  SpeakUpThread,
  SpeakUpThreadList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { createHarness, type Harness, markSessionsVerified, PASSWORD } from "./support/harness";

/**
 * Whistleblowing and speaking up through the API (Phase 2 slice 24; SAFE-012; ADR-0089). The
 * Freedom to Speak Up lead is a member appointed for this test; the owner and the Registered
 * Manager hold every wider permission and still see nothing. Nothing that identifies an anonymous
 * reporter reaches the concern, audit or outbox. Invented people only.
 */

let h: Harness;
let guardian = "";
const GUARDIAN_ID = "0199f000-0000-7000-8000-00000000a5c1";
const ADDRESS = "203.0.113.77";
const json = async <T>(response: Response) => (await response.json()) as T;
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const as = (
  token: string,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) => h.request(path, { token, tenant: DEMO.tenantId, ...init });
const asUser = (user: "owner" | "manager" | "carer" | "nurse", path: string, init = {}) =>
  as(h.tokens[user] as string, path, init);
const asLead = (path: string, init = {}) => as(guardian, path, init);
const publicRequest = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  h.request(path, { method: "POST", body, headers });

async function asDemoTenant<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

async function appointLead(): Promise<string> {
  const email = "gail.guardian@example.invalid";
  const signUp = await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name: "Gail Guardian" },
  });
  const authId = ((await signUp.json()) as { user: { id: string } }).user.id;
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  const token = signIn.headers.get("set-auth-token") as string;
  await asDemoTenant(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status, auth_user_id)
       VALUES ($1, 'Gail Guardian', $2, 'active', $3)`,
      [GUARDIAN_ID, email, authId],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       SELECT $1, id FROM role WHERE key = 'speak_up_guardian'`,
      [GUARDIAN_ID],
    );
  });
  await h.db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [authId]);
  await markSessionsVerified(h.db.pool("harbour_auth"));
  return token;
}

const traces = (concernId: string) =>
  asDemoTenant(async (c) => {
    const audit = await c.query(
      `SELECT action, actor_tenant_user_id, actor_auth_user_id, actor_role_keys, ip, device_id,
              request_id, scope
         FROM audit_event WHERE resource_id = $1 AND action IN
           ('safety.speak_up.raise', 'safety.speak_up.reporter_message', 'safety.speak_up.thread_view')`,
      [concernId],
    );
    const outbox = await c.query("SELECT 1 FROM outbox_event WHERE aggregate_id = $1", [concernId]);
    const versions = await c.query("SELECT 1 FROM record_version WHERE record_id = $1", [
      concernId,
    ]);
    return { audit: audit.rows, outbox: outbox.rows, versions: versions.rows };
  });

async function raiseNamed(identity: "named" | "confidential") {
  const response = await asUser("carer", "/v1/speak-up", {
    method: "POST",
    body: { identity, category: "conduct", summary: "Night staff sleep on shift." },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return json<SpeakUpThread>(response);
}

const step = (id: string, body: Record<string, unknown>) =>
  asLead(`/v1/speak-up/cases/${id}/step`, { method: "POST", body });

beforeAll(async () => {
  h = await createHarness();
  guardian = await appointLead();
  // The nurse is named on cases below: a member reading a case needs MFA like any care record.
  await h.db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [h.authIds.nurse]);
  await markSessionsVerified(h.db.pool("harbour_auth"));
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe("SAFE-012 anonymous concerns (ADR-0089)", () => {
  it("stores no identity, audits against an anonymous actor and publishes nothing", async () => {
    const response = await publicRequest(
      `/p/speak-up/${DEMO.tenantId}`,
      {
        category: "care_quality_or_safety",
        summary: "Medicines left out overnight.",
        wantsReplies: true,
      },
      { "x-forwarded-for": ADDRESS, "x-harbour-device": "0199f000-0000-7000-8000-00000000dead" },
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raised = await json<AnonymousSpeakUpRaised>(response);
    expect(raised.replyToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = raised.replyToken as string;

    const stored = await asDemoTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM speak_up_concern WHERE reply_token_hash = $1", [
        hashOf(token),
      ]);
      return rows;
    });
    expect(stored).toHaveLength(1);
    const concern = stored[0] as Record<string, unknown>;
    expect(concern).toMatchObject({ identity: "anonymous", created_by: null, updated_by: null });
    // The token itself is stored nowhere, only its hash.
    expect(JSON.stringify(stored)).not.toContain(token);
    const reporters = await asDemoTenant(
      async (c) =>
        (await c.query("SELECT 1 FROM speak_up_reporter WHERE concern_id = $1", [concern.id])).rows,
    );
    expect(reporters).toEqual([]);

    // The reporter reads and replies with the token, in the body.
    const thread = await publicRequest(`/p/speak-up/${DEMO.tenantId}/thread`, {
      replyToken: token,
    });
    expect(thread.status).toBe(200);
    expect((await json<SpeakUpThread>(thread)).summary).toBe("Medicines left out overnight.");
    const reply = await publicRequest(
      `/p/speak-up/${DEMO.tenantId}/messages`,
      { replyToken: token, body: "It happened again." },
      { "x-forwarded-for": ADDRESS },
    );
    expect(reply.status).toBe(200);
    expect((await json<SpeakUpThread>(reply)).messages).toHaveLength(1);

    const { audit, outbox, versions } = await traces(concern.id as string);
    expect(audit.map((a) => a.action).sort()).toEqual([
      "safety.speak_up.raise",
      "safety.speak_up.reporter_message",
      "safety.speak_up.thread_view",
    ]);
    for (const event of audit) {
      expect(event).toMatchObject({
        actor_tenant_user_id: null,
        actor_auth_user_id: null,
        actor_role_keys: null,
        ip: null,
        device_id: null,
        request_id: null,
        scope: { actor: "anonymous" },
      });
    }
    expect(JSON.stringify(audit)).not.toContain(ADDRESS);
    expect(outbox).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("opens nothing for a wrong token, and takes no reply on a closed concern", async () => {
    const wrong = await publicRequest(`/p/speak-up/${DEMO.tenantId}/thread`, {
      replyToken: "A".repeat(43),
    });
    expect(wrong.status).toBe(404);
    const malformed = await publicRequest(`/p/speak-up/${DEMO.tenantId}/thread`, {
      replyToken: "short",
    });
    expect(malformed.status).toBe(422);
    const unknownTenant = await publicRequest(`/p/speak-up/0199f000-0000-7000-8000-000000000000`, {
      category: "other",
      summary: "Nobody here.",
      wantsReplies: false,
    });
    expect(unknownTenant.status).toBe(404);
  });

  it("closes an anonymous concern with no way to reply without sharing an outcome", async () => {
    const raised = await publicRequest(`/p/speak-up/${DEMO.tenantId}`, {
      category: "fraud_or_finance",
      summary: "Petty cash does not add up.",
      wantsReplies: false,
    });
    expect((await json<AnonymousSpeakUpRaised>(raised)).replyToken).toBeNull();
    const list = await json<SpeakUpCaseList>(await asLead("/v1/speak-up/cases"));
    let item = list.items.find((i) => i.summary === "Petty cash does not add up.");
    expect(item).toMatchObject({ identity: "anonymous", canReply: false, reporter: null });
    for (const to of ["acknowledged", "under_review"]) {
      item = await json<SpeakUpCaseDetail>(
        await step(item?.id as string, { to, version: item?.version }),
      );
    }
    expect(item?.moves).toEqual(["closed"]);
    const share = await step(item?.id as string, {
      to: "outcome_shared",
      version: item?.version,
      outcome: "Reviewed.",
    });
    expect(share.status).toBe(422);
    const closed = await step(item?.id as string, {
      to: "closed",
      version: item?.version,
      reason: "Reconciled with the bank statements.",
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
  });

  it("throttles public requests by address", async () => {
    let last = 0;
    for (let i = 0; i < 11; i += 1) {
      last = (
        await publicRequest(
          `/p/speak-up/${DEMO.tenantId}/thread`,
          { replyToken: "B".repeat(43) },
          { "x-forwarded-for": "198.51.100.23" },
        )
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe("SAFE-012 named and confidential concerns (ADR-0089)", () => {
  it("keeps a confidential reporter known to the lead alone, and audits the raise with no actor", async () => {
    const raised = await raiseNamed("confidential");
    const lead = await json<SpeakUpCaseDetail>(await asLead(`/v1/speak-up/cases/${raised.id}`));
    expect(lead.reporter?.id).toBe(DEMO.users.carer.id);
    expect(lead.moves).toEqual(["acknowledged"]);

    // A member named on the case sees the case, never who raised it.
    const named = await asLead(`/v1/speak-up/cases/${raised.id}/members`, {
      method: "PUT",
      body: { memberIds: [DEMO.users.nurse.id] },
    });
    expect(named.status, await named.clone().text()).toBe(200);
    const asMember = await asUser("nurse", `/v1/speak-up/cases/${raised.id}`);
    expect(asMember.status, await asMember.clone().text()).toBe(200);
    const memberView = await json<SpeakUpCaseDetail>(asMember);
    expect(memberView.reporter).toBeNull();
    expect(memberView.moves).toEqual([]);

    const { audit, outbox, versions } = await traces(raised.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "safety.speak_up.raise",
      actor_tenant_user_id: null,
      actor_auth_user_id: null,
      ip: null,
      device_id: null,
      request_id: null,
    });
    expect(outbox).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("shows a named reporter to the case's members", async () => {
    const raised = await raiseNamed("named");
    await asLead(`/v1/speak-up/cases/${raised.id}/members`, {
      method: "PUT",
      body: { memberIds: [DEMO.users.nurse.id] },
    });
    const asMember = await json<SpeakUpCaseDetail>(
      await asUser("nurse", `/v1/speak-up/cases/${raised.id}`),
    );
    expect(asMember.reporter?.id).toBe(DEMO.users.carer.id);
    // Removed, the member reads it no more.
    await asLead(`/v1/speak-up/cases/${raised.id}/members`, {
      method: "PUT",
      body: { memberIds: [] },
    });
    expect((await asUser("nurse", `/v1/speak-up/cases/${raised.id}`)).status).toBe(404);
  });

  it("runs the lead's steps, shares the outcome with the reporter, then closes", async () => {
    const raised = await raiseNamed("confidential");
    let item = await json<SpeakUpCaseDetail>(await asLead(`/v1/speak-up/cases/${raised.id}`));
    for (const to of ["acknowledged", "under_review"]) {
      item = await json<SpeakUpCaseDetail>(await step(raised.id, { to, version: item.version }));
    }
    const early = await step(raised.id, {
      to: "closed",
      version: item.version,
      reason: "Looked into it.",
    });
    expect(early.status).toBe(422);
    const message = await asLead(`/v1/speak-up/cases/${raised.id}/messages`, {
      method: "POST",
      body: { body: "Thank you. We are looking into it." },
    });
    expect(message.status).toBe(200);
    item = await json<SpeakUpCaseDetail>(
      await step(raised.id, {
        to: "outcome_shared",
        version: item.version,
        outcome: "Night checks now have a second signature.",
      }),
    );
    const mine = await json<SpeakUpThreadList>(await asUser("carer", "/v1/speak-up/mine"));
    const thread = mine.items.find((i) => i.id === raised.id);
    expect(thread?.outcome).toBe("Night checks now have a second signature.");
    // The reporter is told what the lead said, never which member said it.
    expect(thread?.messages.map((m) => m.author)).toEqual([null]);
    const closed = await step(raised.id, {
      to: "closed",
      version: item.version,
      reason: "Outcome shared and changes made.",
    });
    expect(closed.status).toBe(200);
    const late = await asUser("carer", `/v1/speak-up/mine/${raised.id}/messages`, {
      method: "POST",
      body: { body: "One more thing." },
    });
    expect(late.status).toBe(409);
  });

  it("shows no wider role a concern: not the owner, not the Registered Manager", async () => {
    const raised = await raiseNamed("named");
    for (const user of ["owner", "manager"] as const) {
      const list = await asUser(user, "/v1/speak-up/cases");
      expect(list.status, await list.clone().text()).toBe(200);
      expect((await json<SpeakUpCaseList>(list)).items).toEqual([]);
      expect((await asUser(user, `/v1/speak-up/cases/${raised.id}`)).status).toBe(404);
      expect(
        (
          await asUser(user, `/v1/speak-up/cases/${raised.id}/step`, {
            method: "POST",
            body: { to: "acknowledged", version: 1 },
          })
        ).status,
      ).toBe(403);
      expect(
        (await json<SpeakUpThreadList>(await asUser(user, "/v1/speak-up/mine"))).items,
      ).toEqual([]);
    }
  });
});

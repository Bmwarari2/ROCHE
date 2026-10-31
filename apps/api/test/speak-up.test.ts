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
import {
  createHarness,
  type Harness,
  LODGE,
  markSessionsVerified,
  PASSWORD,
} from "./support/harness";

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

/**
 * The owner database role in the demo organisation; with `userId`, as that member. The silo binds
 * the owner role too, so checks on what was stored read as the lead (`asLeadDb`).
 */
async function asDemoTenant<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
  userId: string | null = null,
): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true),
              set_config('app.user_id', $2, true)`,
      [DEMO.tenantId, userId ?? ""],
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

const asLeadDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) => asDemoTenant(fn, GUARDIAN_ID);

const traces = (concernId: string) =>
  asLeadDb(async (c) => {
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
  // The nurse is named on cases below, and the quality lead appointed lead: reading a case needs
  // MFA like any care record.
  await h.db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id = ANY($1)", [
      [h.authIds.nurse, h.authIds.quality],
    ]);
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

    const stored = await asLeadDb(async (c) => {
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
    const reporters = await asLeadDb(
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

  it("limits public requests per network in Postgres, an IPv6 /64 counting as one", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push(
        (
          await publicRequest(
            `/p/speak-up/${DEMO.tenantId}/thread`,
            { replyToken: "B".repeat(43) },
            { "x-forwarded-for": `2001:db8:5:7::${(i + 1).toString(16)}` },
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Another network is not held back.
    const other = await publicRequest(
      `/p/speak-up/${DEMO.tenantId}/thread`,
      { replyToken: "B".repeat(43) },
      { "x-forwarded-for": "2001:db8:5:8::1" },
    );
    expect(other.status).toBe(404);
    // The count holds no address, only a keyed hash.
    const buckets = await asDemoTenant(async (c) => {
      await c.query("SELECT set_config('app.speak_up', 'true', true)");
      return (await c.query<{ bucket: string }>("SELECT bucket FROM speak_up_intake")).rows;
    });
    expect(JSON.stringify(buckets)).not.toMatch(/2001|db8/);
    expect(buckets.some((b) => /^net:[0-9a-f]{64}$/.test(b.bucket))).toBe(true);
  });

  it("takes the longest concern on the public route, and refuses a body past 48 KiB", async () => {
    // 10,000 four-byte characters: the longest concern there is (about 40 KB), never an emoji.
    const longest = "\u{20000}".repeat(10_000);
    const accepted = await publicRequest(
      `/p/speak-up/${DEMO.tenantId}`,
      { category: "other", summary: longest, wantsReplies: false },
      { "x-forwarded-for": "192.0.2.10" },
    );
    expect(accepted.status, await accepted.clone().text()).toBe(201);
    const tooLarge = await h.request(`/p/speak-up/${DEMO.tenantId}`, {
      method: "POST",
      raw: {
        bytes: new TextEncoder().encode(
          JSON.stringify({ category: "other", summary: "x".repeat(49_200), wantsReplies: false }),
        ),
        contentType: "application/json",
      },
      headers: { "x-forwarded-for": "192.0.2.11" },
    });
    expect(tooLarge.status).toBe(413);
  });

  it("gives the reply token's last date, from the rate table", async () => {
    const raised = await json<AnonymousSpeakUpRaised>(
      await publicRequest(
        `/p/speak-up/${DEMO.tenantId}`,
        { category: "other", summary: "The fire door is propped open.", wantsReplies: true },
        { "x-forwarded-for": "192.0.2.12" },
      ),
    );
    expect(raised.replyTokenExpiresOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((raised.replyTokenExpiresOn as string) > raised.receivedOn).toBe(true);
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

describe("SAFE-012 the lead's view and appointment (ADR-0089 security review)", () => {
  it("pages the lead's list by cursor, and refuses a cursor Harbour did not give", async () => {
    await raiseNamed("named");
    await raiseNamed("named");
    const first = await json<SpeakUpCaseList>(await asLead("/v1/speak-up/cases?limit=2"));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await json<SpeakUpCaseList>(
      await asLead(`/v1/speak-up/cases?limit=2&cursor=${first.nextCursor}`),
    );
    expect(second.items.length).toBeGreaterThan(0);
    for (const item of second.items) {
      expect(first.items.map((i) => i.id)).not.toContain(item.id);
    }
    expect((await asLead("/v1/speak-up/cases?cursor=not-ours")).status).toBe(422);
  });

  it("keeps speak-up audit events out of the owner's audit view", async () => {
    const raised = await raiseNamed("confidential");
    await asLead(`/v1/speak-up/cases/${raised.id}`);
    const response = await asUser("owner", `/v1/audit?resourceId=${raised.id}`);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("speak_up");
    expect((await traces(raised.id)).audit.length).toBeGreaterThan(0);
  });

  it("lets the owner appoint and remove a lead, never themselves, and a carer neither", async () => {
    const quality = LODGE.qualityLeadId;
    const appoint = await asUser("owner", "/v1/speak-up/lead", {
      method: "PUT",
      body: { tenantUserId: quality, appoint: true },
    });
    expect(appoint.status, await appoint.clone().text()).toBe(200);
    expect((await json<{ changed: boolean }>(appoint)).changed).toBe(true);
    const asQuality = await as(h.tokens.quality as string, "/v1/speak-up/cases");
    expect(asQuality.status, await asQuality.clone().text()).toBe(200);
    expect((await json<SpeakUpCaseList>(asQuality)).items.length).toBeGreaterThan(0);
    const remove = await asUser("owner", "/v1/speak-up/lead", {
      method: "PUT",
      body: { tenantUserId: quality, appoint: false },
    });
    expect((await json<{ changed: boolean }>(remove)).changed).toBe(true);
    const after = await as(h.tokens.quality as string, "/v1/speak-up/cases");
    expect((await json<SpeakUpCaseList>(after)).items).toEqual([]);

    const self = await asUser("owner", "/v1/speak-up/lead", {
      method: "PUT",
      body: { tenantUserId: DEMO.users.owner.id, appoint: true },
    });
    expect(self.status).toBe(422);
    const carer = await asUser("carer", "/v1/speak-up/lead", {
      method: "PUT",
      body: { tenantUserId: quality, appoint: true },
    });
    expect(carer.status).toBe(403);
  });

  it("refuses anonymous concerns past the daily limit and shows the lead a possible flood", async () => {
    // Today's count at the limit (as many concerns as SPEAK_UP_ANONYMOUS_PER_DAY allows).
    await asDemoTenant(async (c) => {
      await c.query("SELECT set_config('app.speak_up', 'true', true)");
      await c.query(
        `INSERT INTO speak_up_intake (bucket, window_start, window_end, hits)
         VALUES ('day',
           date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London',
           (date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London')
             + interval '1 day', 50)
         ON CONFLICT (tenant_id, bucket, window_start) DO UPDATE SET hits = 50`,
      );
    });
    const refused = await publicRequest(
      `/p/speak-up/${DEMO.tenantId}`,
      { category: "other", summary: "One more concern.", wantsReplies: false },
      { "x-forwarded-for": "192.0.2.50" },
    );
    expect(refused.status).toBe(429);
    expect((await json<{ code: string }>(refused)).code).toBe("speak_up_daily_limit");
    const list = await json<SpeakUpCaseList>(await asLead("/v1/speak-up/cases"));
    expect(list.possibleFlood).toMatchObject({ cap: 50 });
    const member = await json<SpeakUpCaseList>(await asUser("nurse", "/v1/speak-up/cases"));
    expect(member.possibleFlood).toBeNull();
  });
});

describe("SAFE-012 the lead's staff list (slice 62)", () => {
  it("lists active members for the lead only", async () => {
    const lead = await asLead("/v1/speak-up/staff");
    expect(lead.status).toBe(200);
    const items = (await lead.json()) as { items: { id: string }[] };
    expect(items.items.map((i) => i.id)).toContain(DEMO.users.nurse.id);
    expect((await asUser("owner", "/v1/speak-up/staff")).status).toBe(403);
  });
});

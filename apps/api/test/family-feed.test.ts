import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import {
  createHarness,
  type Harness,
  LODGE,
  markSessionsVerified,
  OTHER,
  PASSWORD,
} from "./support/harness";

/**
 * The family feed through the API (comms.md section 5; COMMS-001; ADR-0061; hazard HZ-022): a
 * portal session sees only what a sharing decision opens, every entry shown is recorded, staff
 * link portal accounts and take updates down, and nothing crosses a tenant or a scope.
 */

let h: Harness;
let family = "";
let familyUserId = "";
let contactId = "";
const ADA = "0194d000-0000-7000-8600-000000000001";
const DAY = 86_400_000;

const as = (token: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token, tenant: DEMO.tenantId });
const staff = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  as(h.tokens[who] as string, path, init);

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true), set_config('app.user_id', $2, true)",
      [DEMO.tenantId, DEMO.users.manager.id],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } finally {
    client.release();
  }
}

const addItem = async (text: string, hoursAgo: number) =>
  (
    await sql<{ id: string }>(
      `INSERT INTO feed_item (person_id, kind, section, source_kind, source_id, occurred_at, text)
       VALUES ($1, 'shared_note', 'daily_updates', 'shared_note', app.uuid_v7(),
         now() - make_interval(hours => $2), $3) RETURNING id`,
      [ADA, hoursAgo, text],
    )
  )[0]?.id as string;

interface Feed {
  items: {
    personId: string;
    statement: string;
    lastUpdateAt: string | null;
    entries: { itemId: string; display: string; text: string }[];
  }[];
}
const feed = async () => (await (await as(family, "/v1/family/feed")).json()) as Feed;

beforeAll(async () => {
  h = await createHarness();
  const email = "fay.family@example.invalid";
  await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name: "Fay Family" },
  });
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  family = signIn.headers.get("set-auth-token") as string;
  const [user] = await h.db
    .pool("harbour_auth")
    .query<{ id: string }>(
      "UPDATE auth.user SET two_factor_enabled = true, email_verified = true WHERE email = $1 RETURNING id",
      [email],
    )
    .then((r) => r.rows);
  await markSessionsVerified(h.db.pool("harbour_auth"));
  const [member] = await sql<{ id: string }>(
    `INSERT INTO tenant_user (display_name, email, status, auth_user_id)
     VALUES ('Fay Family', $1, 'active', $2) RETURNING id`,
    [email, user?.id],
  );
  familyUserId = member?.id as string;
  await sql(
    "INSERT INTO role_assignment (tenant_user_id, role_id) SELECT $1, id FROM role WHERE key = 'family_representative'",
    [familyUserId],
  );
  contactId = (await sql<{ id: string }>("SELECT id FROM contact WHERE person_id = $1", [ADA]))[0]
    ?.id as string;
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-022 the family feed through the API", () => {
  let first = "";
  let decisionId = "";
  let noDecision = "";

  it("links only a portal account, by a holder of people.sharing.manage", async () => {
    const carer = await staff("manager", `/v1/people/${ADA}/family-portal-links`, {
      method: "POST",
      body: { tenantUserId: DEMO.users.carer.id, contactId },
    });
    expect(carer.status).toBe(422);
    // The account's verified email is not the contact's: refused, and the refusal audited.
    const stranger = await staff("manager", `/v1/people/${ADA}/family-portal-links`, {
      method: "POST",
      body: { tenantUserId: familyUserId, contactId },
    });
    expect(stranger.status).toBe(422);
    expect(((await stranger.json()) as { code: string }).code).toBe("account_not_contact");
    const [refusal] = await sql<{ outcome: string }>(
      "SELECT outcome FROM audit_event WHERE action = 'comms.portal_link.create' AND reason = 'account_not_contact'",
    );
    expect(refusal?.outcome).toBe("denied");
    await sql("UPDATE contact SET email = 'Fay.Family@example.invalid' WHERE id = $1", [contactId]);
    expect(
      (
        await staff("carer", `/v1/people/${ADA}/family-portal-links`, {
          method: "POST",
          body: { tenantUserId: familyUserId, contactId },
        })
      ).status,
    ).toBe(403);
    const made = await staff("manager", `/v1/people/${ADA}/family-portal-links`, {
      method: "POST",
      body: { tenantUserId: familyUserId, contactId },
    });
    expect(made.status).toBe(201);
    const list = await staff("manager", `/v1/people/${ADA}/family-portal-links`);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it("hazard HZ-022 the family feed returns nothing without a sharing decision in force", async () => {
    first = await addItem("Joined the garden club.", 24);
    const response = await as(family, "/v1/family/feed");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    noDecision = await response.text();
    const body = JSON.parse(noDecision) as Feed;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.entries).toEqual([]);
  });

  it("shows an update under a decision, records the view and audits ids only", async () => {
    const decision = await staff("manager", `/v1/people/${ADA}/sharing-decisions`, {
      method: "POST",
      body: {
        recipient: { kind: "family", contactId },
        sections: ["daily_updates"],
        basis: "consent",
        consentGivenBy: "person",
        validFrom: new Date(Date.now() - 2 * DAY).toISOString(),
        validTo: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    });
    expect(decision.status).toBe(201);
    decisionId = ((await decision.json()) as { id: string }).id;
    const body = await feed();
    expect(body.items[0]?.entries.map((e) => e.itemId)).toEqual([first]);
    const views = await sql(
      "SELECT sharing_decision_id, section FROM feed_view WHERE feed_item_id = $1",
      [first],
    );
    expect(views).toEqual([{ sharing_decision_id: decisionId, section: "daily_updates" }]);
    const [event] = await sql<{ scope: Record<string, unknown>; reason: string | null }>(
      "SELECT scope, reason FROM audit_event WHERE action = 'comms.feed.viewed' ORDER BY occurred_at DESC LIMIT 1",
    );
    expect(event?.reason).toBeNull();
    expect(JSON.stringify(event?.scope)).not.toContain("garden");
  });

  it("refuses staff the family feed and the family member every staff route", async () => {
    expect((await staff("manager", "/v1/family/feed")).status).toBe(403);
    expect((await as(family, `/v1/people/${ADA}/feed`)).status).toBe(403);
    expect((await as(family, `/v1/people/${ADA}`)).status).toBe(403);
    expect((await as(family, `/v1/people/${ADA}/sharing-decisions`)).status).toBe(403);
  });

  it("takes an update down: a notice for the one who saw it, gone if never seen", async () => {
    const unseen = await addItem("Painted a picture.", 2);
    for (const id of [first, unseen]) {
      const withdrawn = await staff("manager", `/v1/feed-items/${id}/withdraw`, {
        method: "POST",
        body: { reason: "published_in_error" },
      });
      expect(withdrawn.status).toBe(204);
    }
    expect(
      (
        await staff("manager", `/v1/feed-items/${first}/withdraw`, {
          method: "POST",
          body: { reason: "published_in_error" },
        })
      ).status,
    ).toBe(409);
    const entries = (await feed()).items[0]?.entries ?? [];
    expect(entries.map((e) => [e.itemId, e.display])).toEqual([[first, "withdrawn_notice"]]);
    expect(entries[0]?.text).not.toContain("garden");
    const list = await staff("manager", `/v1/people/${ADA}/feed`);
    expect(
      ((await list.json()) as { items: { withdrawn: unknown }[] }).items.every((i) => i.withdrawn),
    ).toBe(true);
    expect(
      (
        await staff("carer", `/v1/feed-items/${first}/withdraw`, {
          method: "POST",
          body: { reason: "person_asked" },
        })
      ).status,
    ).toBe(403);
  });

  it("closes the feed on the next request when the decision is suspended", async () => {
    const shown = await addItem("Went to the music group.", 1);
    expect((await feed()).items[0]?.entries.map((e) => e.itemId)).toContain(shown);
    const [row] = await sql<{ version: number }>(
      "SELECT version FROM sharing_decision WHERE id = $1",
      [decisionId],
    );
    const suspended = await staff(
      "manager",
      `/v1/people/${ADA}/sharing-decisions/${decisionId}/suspend`,
      {
        method: "POST",
        body: { reason: "Safeguarding enquiry", version: row?.version },
      },
    );
    expect(suspended.status).toBe(200);
    expect((await feed()).items[0]?.entries).toEqual([]);
  });

  it("hazard HZ-022 a feed closed by a discharge or death reads exactly as one with no decision", async () => {
    const reopened = await staff("manager", `/v1/people/${ADA}/sharing-decisions`, {
      method: "POST",
      body: {
        recipient: { kind: "family", contactId },
        sections: ["daily_updates"],
        basis: "consent",
        consentGivenBy: "person",
        validFrom: new Date(Date.now() - 2 * DAY).toISOString(),
        validTo: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    });
    expect(reopened.status).toBe(201);
    expect((await feed()).items[0]?.entries.length).toBeGreaterThan(0);
    for (const status of ["discharged", "deceased"]) {
      await sql("UPDATE person SET status = $2 WHERE id = $1", [ADA, status]);
      expect(await (await as(family, "/v1/family/feed")).text()).toBe(noDecision);
    }
    await sql("UPDATE person SET status = 'active' WHERE id = $1", [ADA]);
  });

  it("never takes the people it reads from the request", async () => {
    const asked = await as(
      family,
      `/v1/family/feed?personId=${LODGE.personId}&contactId=${contactId}`,
    );
    const body = (await asked.json()) as Feed;
    expect(body.items.map((i) => i.personId)).toEqual([ADA]);
  });

  it("denies out-of-scope and cross-tenant requests", async () => {
    expect((await staff("manager", `/v1/people/${LODGE.personId}/feed`)).status).toBe(404);
    expect(
      (await staff("manager", `/v1/people/${LODGE.personId}/family-portal-links`)).status,
    ).toBe(404);
    const rae = await h.request(`/v1/people/${ADA}/feed`, {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    expect([403, 404]).toContain(rae.status);
    const elsewhere = await h.request("/v1/family/feed", { token: family, tenant: OTHER.tenantId });
    expect(elsewhere.status).toBe(403);
    const otherItem = await h.request(`/v1/feed-items/${first}/withdraw`, {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
      method: "POST",
      body: { reason: "person_asked" },
    });
    expect([403, 404]).toContain(otherItem.status);
  });

  it("revoking the link ends the portal session's feed", async () => {
    const [link] = await sql<{ id: string; version: number }>(
      "SELECT id, version FROM family_portal_user WHERE tenant_user_id = $1",
      [familyUserId],
    );
    const revoked = await staff(
      "manager",
      `/v1/people/${ADA}/family-portal-links/${link?.id}/revoke`,
      {
        method: "POST",
        body: { reason: "Asked to stop", version: link?.version },
      },
    );
    expect(revoked.status).toBe(200);
    expect((await as(family, "/v1/family/feed")).status).toBe(403);
  });
});

import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Sub-processors and change notices (UK GDPR Art 28; DPA clause 6; platform-completions.md rules
 * 23 to 25): every organisation sees the sub-processors its configuration uses; only the named
 * data protection lead, holding platform.dpia.sign with step-up, acknowledges one or objects to a
 * notice within the organisation's window, with grounds; a later notice reopens an
 * acknowledgement; responses are append-only, audited without the grounds, and never cross
 * organisations.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (who: string, tenant: string = DEMO.tenantId) => ({ token: h.tokens[who], tenant });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const codeOf = async (r: Response) => (await r.json()) as { code: string; detail: string };

type Overview = {
  noticeDays: number;
  mayRespond: boolean;
  inUse: { key: string; acknowledged: boolean }[];
  notices: { id: string; subProcessorKey: string; state: string; windowEndsAt: string }[];
};
const overview = async (who = "owner") =>
  (await (await h.request("/v1/sub-processors", as(who))).json()) as Overview;

/** Runs SQL as the owner role within an organisation, committed. */
async function ownerIn(text: string, values: unknown[] = [], tenant: string = DEMO.tenantId) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [tenant],
    );
    const result = await client.query<Record<string, unknown>>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Thapsus announces a notice (the operator console comes next; the owner role stands in). */
async function announce(key: string, daysAgo: number) {
  const [row] = await ownerIn(
    `INSERT INTO sub_processor_notice (sub_processor_key, kind, use, announced_at, effective_from)
     VALUES ($1, 'replacement', '{"kind":"always"}'::jsonb, now() - make_interval(days => $2),
             now() + interval '60 days')
     RETURNING id`,
    [key, daysAgo],
  );
  return String(row?.id);
}

describe("rules 23 to 25 sub-processors and their notices", () => {
  it("shows each organisation the sub-processors it uses, to those who may read them", async () => {
    const list = await overview();
    expect(list.noticeDays).toBe(30);
    expect(list.mayRespond).toBe(false);
    expect(list.inUse.map((s) => s.key)).toContain("aws_hosting");
    expect(list.inUse.every((s) => !s.acknowledged)).toBe(true);
    expect((await h.request("/v1/sub-processors", as("manager"))).status).toBe(200);
    expect((await h.request("/v1/sub-processors", as("carer"))).status).toBe(403);
    expect((await h.request("/v1/sub-processors", as("owner", OTHER.tenantId))).status).toBe(403);
  });

  it("lets only the named data protection lead acknowledge one", async () => {
    // Before anyone is named, no one may answer.
    const unnamed = await send("POST", "/v1/sub-processors/aws_hosting/acknowledge", "owner", {});
    expect(unnamed.status).toBe(422);
    expect((await codeOf(unnamed)).detail).toContain("named as the organisation's data protection");
    await ownerIn("UPDATE tenant SET data_protection_lead_id = $1 WHERE id = $2", [
      DEMO.users.owner.id,
      DEMO.tenantId,
    ]);
    expect((await overview()).mayRespond).toBe(true);
    expect(
      (await send("POST", "/v1/sub-processors/aws_hosting/acknowledge", "manager", {})).status,
    ).toBe(403);
    expect(
      (await send("POST", "/v1/sub-processors/not_a_sub_processor/acknowledge", "owner", {}))
        .status,
    ).toBe(404);
    // The quality lead holds platform.dpia.sign but is not the named lead.
    const notLead = await send("POST", "/v1/sub-processors/aws_hosting/acknowledge", "quality", {});
    expect(notLead.status).toBe(422);
    expect((await codeOf(notLead)).detail).toContain("named as the organisation's data protection");
    // Answering needs a fresh step-up.
    const auth = h.db.pool("harbour_auth");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(auth, session, 3_600);
    try {
      const stale = await send("POST", "/v1/sub-processors/aws_hosting/acknowledge", "owner", {});
      expect(stale.status).toBe(403);
      expect(((await stale.json()) as { code: string }).code).toBe("step_up_required");
    } finally {
      await ageSession(auth, session, 0);
    }
    const acknowledged = await send(
      "POST",
      "/v1/sub-processors/aws_hosting/acknowledge",
      "owner",
      {},
    );
    expect(acknowledged.status).toBe(201);
    expect((await overview()).inUse.find((s) => s.key === "aws_hosting")?.acknowledged).toBe(true);
    const checklist = (await (await h.request("/v1/onboarding", as("owner"))).json()) as {
      items: { key: string; outstanding: string[] }[];
    };
    expect(
      checklist.items.find((i) => i.key === "sub_processors_acknowledged")?.outstanding,
    ).not.toContain("aws_hosting");
  });

  it("reopens an acknowledgement when a later notice changes the entry", async () => {
    await announce("aws_hosting", 0);
    expect((await overview()).inUse.find((s) => s.key === "aws_hosting")?.acknowledged).toBe(false);
  });

  it("takes an objection within the window, with its grounds, once", async () => {
    const id = await announce("sentry", 1);
    const notice = (await overview()).notices.find((n) => n.id === id);
    expect(notice?.state).toBe("awaiting_response");
    const short = await send("POST", `/v1/sub-processor-notices/${id}/object`, "owner", {
      grounds: "No.",
    });
    expect(short.status).toBe(422);
    const grounds = "Our DPIA does not cover error data leaving the UK for this service.";
    const objected = await send("POST", `/v1/sub-processor-notices/${id}/object`, "owner", {
      grounds,
    });
    expect(objected.status).toBe(201);
    expect((await overview()).notices.find((n) => n.id === id)?.state).toBe("objected");
    for (const [path, body] of [
      [`/v1/sub-processor-notices/${id}/object`, { grounds }],
      ["/v1/sub-processors/sentry/acknowledge", { noticeId: id }],
    ] as const) {
      const again = await send("POST", path, "owner", body);
      expect(again.status).toBe(422);
      expect((await codeOf(again)).detail).toContain("already objected");
    }
    // Nor is the register entry acknowledged while the objection is open.
    const register = await send("POST", "/v1/sub-processors/sentry/acknowledge", "owner", {});
    expect(register.status).toBe(422);
    expect((await codeOf(register)).detail).toContain("already objected");
    // The grounds are shown to DPIA permission holders.
    const ownerView = (await overview()) as unknown as {
      notices: { id: string; objection: { grounds: string | null } | null }[];
    };
    expect(ownerView.notices.find((n) => n.id === id)?.objection?.grounds).toBe(grounds);
    // Another organisation's manager, given the DPIA permissions there, sees the notice and
    // never this organisation's objection.
    await ownerIn(
      `UPDATE role SET permissions = permissions || '{platform.dpia.read,platform.dpia.sign}'
        WHERE key = 'registered_manager'`,
      [],
      OTHER.tenantId,
    );
    const other = (await (
      await h.request("/v1/sub-processors", as("rae", OTHER.tenantId))
    ).json()) as {
      notices: { id: string; state: string; objection: unknown }[];
    };
    const theirs = other.notices.find((n) => n.id === id);
    expect(theirs?.state).toBe("awaiting_response");
    expect(theirs?.objection).toBeNull();
    const events = await ownerIn(
      "SELECT outcome, scope::text AS scope FROM audit_event WHERE action = 'platform.sub_processor.objected' ORDER BY seq",
    );
    expect(events.map((e) => e.outcome)).toEqual(["denied", "success", "denied"]);
    for (const e of events) expect(String(e.scope ?? "")).not.toContain("DPIA does not cover");
  });

  it("refuses an objection once the window has closed: the change is deemed accepted", async () => {
    const id = await announce("grafana", 45);
    expect((await overview()).notices.find((n) => n.id === id)?.state).toBe("deemed_accepted");
    const late = await send("POST", `/v1/sub-processor-notices/${id}/object`, "owner", {
      grounds: "We would have objected to this change had we seen it.",
    });
    expect(late.status).toBe(422);
    expect((await codeOf(late)).detail).toContain("time to object has passed");
  });

  it("hazard HZ-011 keeps responses append-only, the lead's own, and in their organisation", async () => {
    const client = await h.db.pool("harbour_app").connect();
    const as = (member: string, tenant: string = DEMO.tenantId) =>
      client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', 'tenant', true)`,
        [tenant, member],
      );
    try {
      await client.query("BEGIN");
      await as(LODGE.qualityLeadId);
      await client.query("SAVEPOINT s");
      // The quality lead holds platform.dpia.sign but is not the named lead.
      await expect(
        client.query(
          "INSERT INTO sub_processor_response (sub_processor_key, kind) VALUES ('sentry', 'acknowledged')",
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK TO SAVEPOINT s");
      // Only Thapsus announces a notice.
      await expect(
        client.query(
          `INSERT INTO sub_processor_notice (sub_processor_key, kind, use, announced_at, effective_from)
           VALUES ('sentry', 'new', '{"kind":"always"}', now(), now())`,
        ),
      ).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(
        client.query("UPDATE sub_processor_response SET grounds = NULL"),
      ).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
      // The other organisation's own named lead, who reads their organisation's responses, sees
      // none of this one's.
      await ownerIn(
        "UPDATE tenant SET data_protection_lead_id = $1 WHERE id = $2",
        [OTHER.managerId, OTHER.tenantId],
        OTHER.tenantId,
      );
      await client.query("BEGIN");
      await as(OTHER.managerId, OTHER.tenantId);
      expect((await client.query("SELECT id FROM sub_processor_response")).rowCount).toBe(0);
      await client.query("ROLLBACK");
      // The operator role has no direct access: it resolves only through its definer function.
      const operator = await h.db.pool("harbour_operator").connect();
      try {
        await operator.query("BEGIN");
        await operator.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
        await expect(
          operator.query(
            `INSERT INTO sub_processor_response (tenant_id, sub_processor_key, kind, responded_by)
             VALUES ($1, 'sentry', 'acknowledged', $2)`,
            [DEMO.tenantId, DEMO.users.owner.id],
          ),
        ).rejects.toThrow(/permission denied/);
      } finally {
        await operator.query("ROLLBACK");
        operator.release();
      }
      await client.query("BEGIN");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

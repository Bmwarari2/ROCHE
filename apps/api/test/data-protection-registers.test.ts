import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outboxHandlers, relayOutbox } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * The breach register, Thapsus's processor breach notices and data protection complaints
 * (PLAT-022; platform.md rules 6 to 10 and 18 to 26): quality.dsar.manage only; clocks from the
 * rate table worked out on every read; the assessment only suggests and the decision is a
 * person's, with reasons; a late ICO report needs the reasons for the delay; the notice to the
 * people affected comes from the template and is not recorded while it holds a prompt; closed
 * records never change; audit events carry ids and codes, never the text; Thapsus's notice opens
 * the organisation's register entry and tells its lead and owners.
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
const get = (path: string, who = "owner") => h.request(path, as(who));
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const codeOf = async (r: Response) => (await json<{ code: string }>(r)).code;
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const today = () => new Date().toISOString().slice(0, 10);

type Breach = {
  id: string;
  version: number;
  source: string;
  status: string;
  suggestion: { severity: string; considerReportingToIco: boolean } | null;
  clock: { state: string; hoursLeft: number | null; delayReasonRequired: boolean };
  notices: { id: string; acknowledgedAt: string | null }[];
};
type Complaint = {
  id: string;
  version: number;
  status: string;
  clock: { acknowledgeDueOn: string | null; acknowledgement: string; update: string };
};

const FACTORS = {
  peopleAffected: 3,
  identifiable: true,
  specialCategory: true,
  safeguardingOrLocationAtRisk: false,
  disclosedOutsideOrganisation: true,
  careRecordsUnavailable: false,
  contained: false,
};

/** Reads as the owner role within the demo organisation (row-level security still applies). */
async function ownerRead<T extends Record<string, unknown>>(text: string, values: unknown[]) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

const auditFor = (resourceId: string) =>
  ownerRead<{ action: string; scope: unknown }>(
    "SELECT action, scope FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at",
    [resourceId],
  );

async function record(awareHoursAgo: number, who = "owner"): Promise<Breach> {
  const r = await send("POST", "/v1/data-protection/breaches", who, {
    summary: "Care notes for three people were emailed to an outside address.",
    awareAt: hoursAgo(awareHoursAgo),
  });
  expect(r.status).toBe(201);
  return json<Breach>(r);
}

describe("PLAT-022 the breach register", () => {
  it("is for holders of quality.dsar.manage only, in their own organisation", async () => {
    expect((await get("/v1/data-protection/breaches", "manager")).status).toBe(200);
    expect((await get("/v1/data-protection/breaches", "quality")).status).toBe(200);
    expect((await get("/v1/data-protection/breaches", "carer")).status).toBe(403);
    expect((await get("/v1/data-protection/breaches", "nurse")).status).toBe(403);
    const mine = await record(1);
    const other = await h.request(
      `/v1/data-protection/breaches/${mine.id}`,
      as("rae", OTHER.tenantId),
    );
    expect([403, 404]).toContain(other.status);
  });

  it("works out the ICO clock from the rate table on every read", async () => {
    const fresh = await record(2);
    expect(fresh.clock.state).toBe("open");
    expect(fresh.clock.hoursLeft).toBe(69);
    const old = await record(80);
    expect(old.clock).toMatchObject({ state: "overdue", hoursLeft: 0, delayReasonRequired: true });
  });

  it("suggests a severity, refuses a decision without reasons or against the suggestion unacknowledged, and records a person's decision", async () => {
    const b = await record(5);
    const decideEarly = await send(
      "POST",
      `/v1/data-protection/breaches/${b.id}/decision`,
      "owner",
      {
        expectedVersion: b.version,
        reportToIco: true,
        tellIndividuals: true,
        reasoning: "Special category data went outside the organisation.",
      },
    );
    expect(await codeOf(decideEarly)).toBe("not_assessed");
    const assessed = await json<Breach>(
      await send("POST", `/v1/data-protection/breaches/${b.id}/assessment`, "owner", {
        expectedVersion: b.version,
        factors: FACTORS,
      }),
    );
    expect(assessed.suggestion).toMatchObject({ severity: "high", considerReportingToIco: true });
    const short = await send("POST", `/v1/data-protection/breaches/${b.id}/decision`, "owner", {
      expectedVersion: assessed.version,
      reportToIco: true,
      tellIndividuals: true,
      reasoning: "too short",
    });
    expect(short.status).toBe(422);
    expect(await codeOf(short)).toBe("reasoning_required");
    const against = await send("POST", `/v1/data-protection/breaches/${b.id}/decision`, "owner", {
      expectedVersion: assessed.version,
      reportToIco: false,
      tellIndividuals: false,
      reasoning: "We think the recipient deleted it straight away.",
    });
    expect(await codeOf(against)).toBe("acknowledgement_required");
    const stale = await send("POST", `/v1/data-protection/breaches/${b.id}/decision`, "owner", {
      expectedVersion: b.version,
      reportToIco: true,
      tellIndividuals: true,
      reasoning: "Special category data went outside the organisation.",
    });
    expect(stale.status).toBe(409);
    const decided = await send("POST", `/v1/data-protection/breaches/${b.id}/decision`, "owner", {
      expectedVersion: assessed.version,
      reportToIco: true,
      tellIndividuals: true,
      reasoning: "Special category data went outside the organisation.",
    });
    expect(decided.status).toBe(200);
    const audit = await auditFor(b.id);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "platform.breach.recorded",
        "platform.breach.assessed",
        "platform.breach.decided",
      ]),
    );
    expect(JSON.stringify(audit)).not.toMatch(/Special category data went|Care notes for three/);
  });

  it("needs reasons for a late ICO report, a finished notice, and every step before closing", async () => {
    const b = await record(90);
    let cur = await json<Breach>(
      await send("POST", `/v1/data-protection/breaches/${b.id}/assessment`, "manager", {
        expectedVersion: b.version,
        factors: FACTORS,
      }),
    );
    const notDecided = await send(
      "POST",
      `/v1/data-protection/breaches/${b.id}/ico-report`,
      "manager",
      {
        expectedVersion: cur.version,
        reportedAt: hoursAgo(1),
        icoReference: "IC-123456",
      },
    );
    expect(await codeOf(notDecided)).toBe("not_decided_to_report");
    cur = await json<Breach>(
      await send("POST", `/v1/data-protection/breaches/${b.id}/decision`, "manager", {
        expectedVersion: cur.version,
        reportToIco: true,
        tellIndividuals: true,
        reasoning: "Special category data went outside the organisation.",
      }),
    );
    const late = await send("POST", `/v1/data-protection/breaches/${b.id}/ico-report`, "manager", {
      expectedVersion: cur.version,
      reportedAt: hoursAgo(1),
      icoReference: "IC-123456",
    });
    expect(await codeOf(late)).toBe("delay_reason_required");
    cur = await json<Breach>(
      await send("POST", `/v1/data-protection/breaches/${b.id}/ico-report`, "manager", {
        expectedVersion: cur.version,
        reportedAt: hoursAgo(1),
        icoReference: "IC-123456",
        delayReason: "The facts were not known until the recipient replied.",
      }),
    );
    expect(cur.clock.state).toBe("reported_late");
    const moved = await send("POST", `/v1/data-protection/breaches/${b.id}/facts`, "manager", {
      expectedVersion: cur.version,
      awareAt: hoursAgo(100),
    });
    expect(await codeOf(moved)).toBe("aware_at_fixed");
    const closeEarly = await send("POST", `/v1/data-protection/breaches/${b.id}/close`, "manager", {
      expectedVersion: cur.version,
      lessons: "Check the address before sending care notes by email.",
    });
    expect(await codeOf(closeEarly)).toBe("not_told");
    const draft = await json<{ notice: string }>(
      await get(`/v1/data-protection/breaches/${b.id}/subject-notice-draft`, "manager"),
    );
    expect(draft.notice).toContain("What happened");
    const unfinished = await send(
      "POST",
      `/v1/data-protection/breaches/${b.id}/individuals-told`,
      "manager",
      {
        expectedVersion: cur.version,
        notice: draft.notice,
        toldOn: today(),
      },
    );
    expect(await codeOf(unfinished)).toBe("notice_unfinished");
    cur = await json<Breach>(
      await send("POST", `/v1/data-protection/breaches/${b.id}/individuals-told`, "manager", {
        expectedVersion: cur.version,
        notice: draft.notice.replace(/\[Write [^\]]*\]/g, "Details written by the lead."),
        toldOn: today(),
      }),
    );
    const closed = await json<Breach>(
      await send("POST", `/v1/data-protection/breaches/${b.id}/close`, "manager", {
        expectedVersion: cur.version,
        lessons: "Check the address before sending care notes by email.",
      }),
    );
    expect(closed.status).toBe("closed");
    const after = await send("POST", `/v1/data-protection/breaches/${b.id}/facts`, "manager", {
      expectedVersion: closed.version,
      summary: "Trying to change it afterwards.",
    });
    expect(await codeOf(after)).toBe("breach_closed");
  });
});

describe("PLAT-022 Thapsus's breach notice", () => {
  const NOTICE = {
    tenantId: DEMO.tenantId,
    nature: "A misconfigured export link was reachable without signing in for an hour.",
    dataCategories: "Names and care notes",
    approxPeople: 12,
    likelyConsequences: "Possible distress",
    measures: "The link was disabled and access logs reviewed.",
    tenantActions: "Decide whether to report to the ICO.",
    contact: "dpo@thapsus.example.invalid",
  };

  it("is sent only by an admin, opens the register entry, tells the lead and owners, and is acknowledged once", async () => {
    expect(
      (
        await h.request("/operator/breach-notices", {
          token: h.tokens.opsSupport,
          method: "POST",
          body: NOTICE,
        })
      ).status,
    ).toBe(403);
    expect((await send("POST", "/operator/breach-notices", "owner", NOTICE)).status).toBe(403);
    const sent = await h.request("/operator/breach-notices", {
      token: h.tokens.opsAdmin,
      method: "POST",
      body: NOTICE,
    });
    expect(sent.status).toBe(201);
    const { noticeId, breachId } = await json<{ noticeId: string; breachId: string }>(sent);
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: h.handle.services.db,
      logger: createLogger("silent"),
    };
    await relayOutbox(deps, outboxHandlers(deps));
    const told = await ownerRead<{ recipient_tenant_user_id: string; severity: string }>(
      "SELECT recipient_tenant_user_id, severity FROM notification WHERE source_id = $1",
      [noticeId],
    );
    expect(told.map((r) => r.recipient_tenant_user_id)).toContain(DEMO.users.owner.id);
    expect(told.every((r) => r.severity === "urgent")).toBe(true);
    const entry = await json<Breach>(await get(`/v1/data-protection/breaches/${breachId}`));
    expect(entry).toMatchObject({ source: "processor_notice", status: "open" });
    expect(entry.notices).toEqual([
      expect.objectContaining({ id: noticeId, acknowledgedAt: null }),
    ]);
    const ack = await send(
      "POST",
      `/v1/data-protection/breach-notices/${noticeId}/acknowledge`,
      "owner",
    );
    expect(ack.status).toBe(200);
    expect((await json<Breach>(ack)).notices[0]?.acknowledgedAt).not.toBeNull();
    const again = await send(
      "POST",
      `/v1/data-protection/breach-notices/${noticeId}/acknowledge`,
      "manager",
    );
    expect(await codeOf(again)).toBe("already_acknowledged");
    const followUp = await h.request("/operator/breach-notices", {
      token: h.tokens.opsAdmin,
      method: "POST",
      body: {
        ...NOTICE,
        followsId: noticeId,
        nature: "Logs show two downloads from an unknown address.",
      },
    });
    expect((await json<{ breachId: string }>(followUp)).breachId).toBe(breachId);
  });
});

describe("PLAT-022 data protection complaints", () => {
  it("records a complaint, works out its clocks, and closes it only with the ICO right stated", async () => {
    const received = today();
    expect(
      (
        await send("POST", "/v1/data-protection/complaints", "carer", {
          receivedOn: received,
          channel: "phone",
          complainantKind: "family",
          complainantName: "Eve Example",
          about: "access",
          summary: "They asked for their mother's records and heard nothing.",
        })
      ).status,
    ).toBe(403);
    const elsewhere = await send("POST", "/v1/data-protection/complaints", "quality", {
      receivedOn: received,
      channel: "letter",
      complainantKind: "family",
      complainantName: "Finn Sample",
      personId: OTHER.personId,
      about: "sharing",
      summary: "A person from another organisation, which must not be linked.",
    });
    expect(await codeOf(elsewhere)).toBe("person_not_found");
    const r = await send("POST", "/v1/data-protection/complaints", "quality", {
      receivedOn: received,
      channel: "phone",
      complainantKind: "family",
      complainantName: "Eve Example",
      complainantContact: "eve.example@example.invalid",
      about: "access",
      summary: "They asked for their mother's records and heard nothing.",
    });
    expect(r.status).toBe(201);
    let c = await json<Complaint>(r);
    expect(c.clock.acknowledgement).toBe("due");
    expect(c.clock.acknowledgeDueOn).not.toBeNull();
    const closeEarly = await send(
      "POST",
      `/v1/data-protection/complaints/${c.id}/close`,
      "quality",
      {
        expectedVersion: c.version,
        closedOn: received,
        outcome: "We sent the records and apologised for the delay.",
        icoRightStated: false,
      },
    );
    expect(await codeOf(closeEarly)).toBe("ico_right_required");
    c = await json<Complaint>(
      await send("POST", `/v1/data-protection/complaints/${c.id}/acknowledge`, "quality", {
        expectedVersion: c.version,
        on: received,
      }),
    );
    expect(c.clock.acknowledgement).toBe("done");
    const future = await send("POST", `/v1/data-protection/complaints/${c.id}/contact`, "quality", {
      expectedVersion: c.version,
      on: "2999-01-01",
    });
    expect(await codeOf(future)).toBe("date_out_of_range");
    c = await json<Complaint>(
      await send("POST", `/v1/data-protection/complaints/${c.id}/close`, "quality", {
        expectedVersion: c.version,
        closedOn: received,
        outcome: "We sent the records and apologised; you may complain to the ICO.",
        icoRightStated: true,
      }),
    );
    expect(c).toMatchObject({ status: "closed", clock: { update: "closed" } });
    const audit = await auditFor(c.id);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "platform.dp_complaint.recorded",
        "platform.dp_complaint.acknowledged",
        "platform.dp_complaint.closed",
      ]),
    );
    expect(JSON.stringify(audit)).not.toMatch(/Eve Example|example\.invalid|mother's records/);
  });
});

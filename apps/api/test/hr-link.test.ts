import { createHmac } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { OUTBOUND_FIELDS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockThapsusHr } from "../src/integrations/thapsus-hr";
import { syncHrLinks } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness } from "./support/harness";

/**
 * The Thapsus-HR link through the API (INTG-014; integrations.md section 11; slice 87; migration
 * 0141; hazard HZ-133): off unless the flag is on; connecting needs step-up and a UK workspace on
 * its UK address; employees matched by number or by work email with date of birth, never by name,
 * the rest to a review queue decided in the reviewer's own name; leavers lose sign-in at the end
 * of their leaving day even if later syncs fail; drift put back to the owner's version; the signed
 * webhook with its replay window and quarantine; starters created once. Invented people only.
 */

let h: Harness;
const T = DEMO.tenantId;
const PROJECT = "harbour-test-77";
const SECRET_REF = `projects/${PROJECT}/locations/europe-west2/secrets/harbour_int_${T}_thapsus-hr-webhook`;
const SECRET = "whsec_invented_for_tests";
const DOMAIN = "thapsus.example.invalid";
const BASE = `https://api.uk.${DOMAIN}`;

const as = (who: string) => ({ token: h.tokens[who], tenant: T });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const get = (path: string, who = "manager") => send("GET", path, who);
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

async function owner<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [T],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } finally {
    client.release();
  }
}

const FILES = {
  carer: "0199f100-0000-7000-8000-000000000001",
  manager: "0199f100-0000-7000-8000-000000000002",
  leaver: "0199f100-0000-7000-8000-000000000003",
  starter: "0199f100-0000-7000-8000-000000000004",
  spare: "0199f100-0000-7000-8000-000000000005",
};
const LEAVER_MEMBER = "0199f100-0000-7000-8000-000000000011";
const STARTER_MEMBER = "0199f100-0000-7000-8000-000000000012";
const SPARE_MEMBER = "0199f100-0000-7000-8000-000000000013";
const INVALID_MEMBER = "0199f100-0000-7000-8000-000000000014";
const RETURNED_MEMBER = "0199f100-0000-7000-8000-000000000015";
const INVALID_FILE = "0199f100-0000-7000-8000-000000000006";
const RETURNED_FILE = "0199f100-0000-7000-8000-000000000007";

const ukDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });

let mock: MockThapsusHr;
const workspace = (homeRegion = "uk") => ({ slug: "demo-care", homeRegion, apiBaseUrl: BASE });
const connectBody = { workspaceSlug: "demo-care", secretRef: SECRET_REF };
const employee = (over: Record<string, unknown>) => ({
  employeeNumber: null,
  workEmail: null,
  dateOfBirth: null,
  givenName: "Ada",
  familyName: "Example",
  leavingDate: null,
  ...over,
});

const sign = (body: string, at = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
const webhook = (body: string, signature?: string, tenant: string = T) =>
  h.request(`/p/integrations/thapsus-hr/${tenant}`, {
    method: "POST",
    raw: { bytes: new TextEncoder().encode(body), contentType: "application/json" },
    ...(signature ? { headers: { "thapsus-signature": signature } } : {}),
  });

beforeAll(async () => {
  h = await createHarness({ GCP_PROJECT_ID: PROJECT, THAPSUS_HR_DOMAIN: DOMAIN });
  h.handle.services.hrLink.secrets.set(SECRET_REF, SECRET);
  await owner(
    `INSERT INTO tenant_user (id, display_name, email, status) VALUES
       ($1, 'Lee Leaver', 'lee.leaver@example.invalid', 'active'),
       ($2, 'Sam Starter', 'sam.starter@example.invalid', 'active'),
       ($3, 'Pat Spare', 'pat.spare@example.invalid', 'active'),
       ($4, 'Ivy Invalid', 'ivy.invalid@example.invalid', 'active'),
       ($5, 'Ray Returned', 'ray.returned@example.invalid', 'active')`,
    [LEAVER_MEMBER, STARTER_MEMBER, SPARE_MEMBER, INVALID_MEMBER, RETURNED_MEMBER],
  );
  await owner(
    `INSERT INTO staff_profile (id, tenant_user_id, job_title, date_of_birth, starts_on) VALUES
       ($1, $3, 'Care worker', '1991-09-07', '2024-02-05'),
       ($2, $4, 'Care worker', '1993-10-08', '2024-03-04')`,
    [INVALID_FILE, RETURNED_FILE, INVALID_MEMBER, RETURNED_MEMBER],
  );
  // A leaving recorded here once and then withdrawn (soft-deleted).
  await owner(
    `INSERT INTO leaver_record (staff_profile_id, leaving_on, reason, deleted_at)
     VALUES ($1, '2025-06-30', 'resignation', now())`,
    [RETURNED_FILE],
  );
  await owner(
    `INSERT INTO staff_profile (id, tenant_user_id, job_title, date_of_birth, starts_on) VALUES
       ($1, $6, 'Care worker', '1990-04-02', '2025-01-06'),
       ($2, $7, 'Registered Manager', '1980-05-03', '2020-01-06'),
       ($3, $8, 'Care worker', '1992-06-04', '2024-01-08'),
       ($4, $9, 'Care worker', '1999-07-05', '2026-12-01'),
       ($5, $10, 'Care worker', '1995-08-06', '2023-03-01')`,
    [
      FILES.carer,
      FILES.manager,
      FILES.leaver,
      FILES.starter,
      FILES.spare,
      DEMO.users.carer.id,
      DEMO.users.manager.id,
      LEAVER_MEMBER,
      STARTER_MEMBER,
      SPARE_MEMBER,
    ],
  );
});

afterAll(async () => {
  await h?.close();
});

describe("INTG-014 the link is off unless the flag is on", () => {
  it("refuses every route while integrations.thapsus_hr is off", async () => {
    const r = await get("/v1/integrations/hr-link");
    expect(r.status).toBe(403);
    expect(await codeOf(r)).toBe("feature_disabled");
    expect((await webhook("{}", sign("{}"))).status).toBe(401);
    await owner(
      "INSERT INTO feature_flag (flag_key, enabled) VALUES ('integrations.thapsus_hr', true)",
    );
    expect((await get("/v1/integrations/hr-link")).status).toBe(200);
  });

  it("keeps the link's routes from people without an HR link permission", async () => {
    expect((await get("/v1/integrations/hr-link", "carer")).status).toBe(403);
    expect((await get("/v1/integrations/hr-link/matches", "nurse")).status).toBe(403);
    expect((await send("POST", "/v1/integrations/hr-link", "nurse", connectBody)).status).toBe(403);
  });
});

describe("hazard HZ-133 connecting only with a UK workspace on its UK address (rule 1)", () => {
  it("refuses a workspace that says it is outside the UK, sending and keeping nothing", async () => {
    h.handle.services.hrLink.mocks.set(T, new MockThapsusHr(workspace("eu"), BASE));
    const r = await send("POST", "/v1/integrations/hr-link", "manager", connectBody);
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe("hr_link_not_uk");
    expect((await get("/v1/integrations/hr-link")).status).toBe(200);
    expect(
      await owner("SELECT 1 FROM integration_connection WHERE port = 'integrations.hr_link'"),
    ).toHaveLength(0);
  });

  it("never takes Thapsus's domain from the caller, and refuses a stale step-up", async () => {
    const bad = await send("POST", "/v1/integrations/hr-link", "manager", {
      ...connectBody,
      thapsusDomain: "other.example.invalid",
    });
    expect(bad.status).toBe(422);
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(h.db.pool("harbour_auth"), session, 3_600);
    try {
      const r = await send("POST", "/v1/integrations/hr-link", "manager", connectBody);
      expect(r.status).toBe(403);
    } finally {
      await ageSession(h.db.pool("harbour_auth"), session, 0);
    }
  });
});

describe("hazard HZ-133 matching never relies on a name (rule 3)", () => {
  it("links by work email with date of birth, and sends the rest to review", async () => {
    mock = new MockThapsusHr(workspace(), BASE);
    h.handle.services.hrLink.mocks.set(T, mock);
    const add = (id: string, over: Record<string, unknown>) =>
      mock.employeesById.set(id, { id, ...employee(over) } as never);
    // The carer: email and date of birth agree, so linked; Thapsus-HR's job title differs.
    add("emp_carer", {
      employeeNumber: "E100",
      workEmail: DEMO.users.carer.email,
      dateOfBirth: "1990-04-02",
      jobTitle: "Senior care worker",
    });
    // Same email as the manager but another date of birth: never a link.
    add("emp_conflict", { workEmail: DEMO.users.manager.email, dateOfBirth: "1981-01-01" });
    // The same name as the carer and nothing else: never matched by name.
    add("emp_name_only", { givenName: "Cat", familyName: "Carer" });
    // The leaver, with a leaving date already past.
    add("emp_leaver", {
      workEmail: "lee.leaver@example.invalid",
      dateOfBirth: "1992-06-04",
      leavingDate: ukDay(-2),
    });
    // A leaving date that is not a real day: fails safe as today (rule 8).
    add("emp_invalid", {
      workEmail: "ivy.invalid@example.invalid",
      dateOfBirth: "1991-09-07",
      leavingDate: "2026-02-30",
    });
    // A leaver whose earlier leaving here was withdrawn: put back, never a failed pull.
    add("emp_returned", {
      workEmail: "ray.returned@example.invalid",
      dateOfBirth: "1993-10-08",
      leavingDate: ukDay(-3),
    });
    const r = await send("POST", "/v1/integrations/hr-link", "manager", connectBody);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({
      linked: 4,
      review: 2,
      leavers: 3,
      drift: 1,
      failed: 0,
      error: null,
    });
    const links = await owner<{
      hr_employee_id: string;
      state: string;
      match_method: string | null;
    }>(
      "SELECT hr_employee_id, state, match_method, review_reason FROM hr_person_link ORDER BY hr_employee_id",
    );
    expect(links).toEqual([
      {
        hr_employee_id: "emp_carer",
        state: "linked",
        match_method: "email_and_birth_date",
        review_reason: null,
      },
      {
        hr_employee_id: "emp_conflict",
        state: "review",
        match_method: null,
        review_reason: "no_match",
      },
      {
        hr_employee_id: "emp_invalid",
        state: "linked",
        match_method: "email_and_birth_date",
        review_reason: null,
      },
      {
        hr_employee_id: "emp_leaver",
        state: "linked",
        match_method: "email_and_birth_date",
        review_reason: null,
      },
      {
        hr_employee_id: "emp_name_only",
        state: "review",
        match_method: null,
        review_reason: "no_match",
      },
      {
        hr_employee_id: "emp_returned",
        state: "linked",
        match_method: "email_and_birth_date",
        review_reason: null,
      },
    ]);
  });

  it("stores no name, email or date of birth from Thapsus-HR in the link", async () => {
    const rows = await owner("SELECT * FROM hr_person_link");
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/example\.invalid|1990-04-02|Ada|Cat/);
  });

  it("audits every write the sync makes as the link, with opaque identifiers", async () => {
    const events = await owner<{ action: string; actor_auth_user_id: string }>(
      "SELECT action, actor_auth_user_id FROM audit_event WHERE action LIKE 'integrations.hr_link.%' AND actor_auth_user_id = 'integration:thapsus_hr'",
    );
    const actions = new Set(events.map((e) => e.action));
    expect(actions).toEqual(
      new Set([
        "integrations.hr_link.person_linked",
        "integrations.hr_link.match_review",
        "integrations.hr_link.leaving_recorded",
        "integrations.hr_link.drift_detected",
        "integrations.hr_link.leaving_date_invalid",
      ]),
    );
  });
});

describe("hazard HZ-133 reconciliation puts back the owner's version (rule 2)", () => {
  it("puts back Thapsus-HR's job title over Harbour's copy and records the drift", async () => {
    const [file] = await owner<{ job_title: string }>(
      "SELECT job_title FROM staff_profile WHERE id = $1",
      [FILES.carer],
    );
    expect(file?.job_title).toBe("Senior care worker");
    const events = await owner(
      "SELECT 1 FROM outbox_event WHERE event_type = 'integrations.hr_link.drift_detected'",
    );
    expect(events).toHaveLength(1);
  });
});

describe("hazard HZ-133 a leaver's sign-in ends with their leaving day, even if later syncs fail (rule 8)", () => {
  it("records the leaving date and ends access once the day is over", async () => {
    const [member] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [LEAVER_MEMBER],
    );
    expect(member?.status).toBe("left");
    const [leaving] = await owner<{ leaving_on: string }>(
      "SELECT to_char(leaving_on, 'YYYY-MM-DD') AS leaving_on FROM leaver_record WHERE staff_profile_id = $1",
      [FILES.leaver],
    );
    expect(leaving?.leaving_on).toBe(ukDay(-2));
  });

  it("takes the leaver off the rota from their leaving day (left_on), with how long the file is kept", async () => {
    const [file] = await owner<{ left_on: string }>(
      "SELECT to_char(left_on, 'YYYY-MM-DD') AS left_on FROM staff_profile WHERE id = $1",
      [FILES.leaver],
    );
    expect(file?.left_on).toBe(ukDay(-2));
    const [kept] = await owner<{ kept: boolean }>(
      "SELECT staff_file_retain_until IS NOT NULL AS kept FROM leaver_record WHERE staff_profile_id = $1",
      [FILES.leaver],
    );
    expect(kept?.kept).toBe(true);
  });

  it("fails safe on a leaving date that is not a real day: it counts as today", async () => {
    const [leaving] = await owner<{ leaving_on: string }>(
      "SELECT to_char(leaving_on, 'YYYY-MM-DD') AS leaving_on FROM leaver_record WHERE staff_profile_id = $1",
      [INVALID_FILE],
    );
    expect(leaving?.leaving_on).toBe(ukDay(0));
    expect(
      await owner(
        "SELECT 1 FROM outbox_event WHERE event_type = 'integrations.hr_link.leaving_date_invalid'",
      ),
    ).toHaveLength(1);
  });

  it("puts back a withdrawn leaving rather than failing the whole pull", async () => {
    const [leaving] = await owner<{ deleted: boolean }>(
      "SELECT deleted_at IS NOT NULL AS deleted FROM leaver_record WHERE staff_profile_id = $1",
      [RETURNED_FILE],
    );
    expect(leaving?.deleted).toBe(false);
    const [member] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [RETURNED_MEMBER],
    );
    expect(member?.status).toBe("left");
  });

  it("refuses changing here what Thapsus-HR owns for a linked member (rule 2)", async () => {
    const p = (await (await get(`/v1/workforce/staff-files/${FILES.carer}`)).json()) as Record<
      string,
      unknown
    > & { version: number };
    const r = await send("PATCH", `/v1/workforce/staff-files/${FILES.carer}`, "manager", {
      expectedVersion: p.version,
      locationId: p.locationId ?? null,
      jobTitle: "Night care worker",
      pathwayCategory: p.pathwayCategory ?? null,
      registrationBody: p.registrationBody ?? null,
      previousCareWork: p.previousCareWork ?? false,
      dateOfBirth: p.dateOfBirth ?? null,
      startsOn: p.startsOn ?? null,
      leftOn: p.leftOn ?? null,
    });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("managed_in_thapsus_hr");
  });

  it("keeps a future leaving date when Thapsus-HR later drops it or the sync fails", async () => {
    const entry = mock.employeesById.get("emp_carer") as unknown as Record<string, unknown>;
    entry.leavingDate = ukDay(3);
    expect((await send("POST", "/v1/integrations/hr-link/sync", "manager")).status).toBe(200);
    entry.leavingDate = null;
    entry.jobTitle = "Senior care worker";
    expect((await send("POST", "/v1/integrations/hr-link/sync", "manager")).status).toBe(200);
    mock.callsLeft = 0;
    const failed = await send("POST", "/v1/integrations/hr-link/sync", "manager");
    expect(((await failed.json()) as { error: string }).error).toBe("rate_limited");
    const afterFailure = (await (await get("/v1/integrations/hr-link")).json()) as {
      staleness: { lastErrorCode: string | null; failures: number };
    };
    expect(afterFailure.staleness).toMatchObject({ lastErrorCode: "rate_limited", failures: 1 });
    mock.callsLeft = Number.POSITIVE_INFINITY;
    const [leaving] = await owner<{ leaving_on: string }>(
      "SELECT to_char(leaving_on, 'YYYY-MM-DD') AS leaving_on FROM leaver_record WHERE staff_profile_id = $1",
      [FILES.carer],
    );
    expect(leaving?.leaving_on).toBe(ukDay(3));
  });

  it("never moves a known leaving date later", async () => {
    const entry = mock.employeesById.get("emp_carer") as unknown as Record<string, unknown>;
    entry.leavingDate = ukDay(30);
    await send("POST", "/v1/integrations/hr-link/sync", "manager");
    const [leaving] = await owner<{ leaving_on: string }>(
      "SELECT to_char(leaving_on, 'YYYY-MM-DD') AS leaving_on FROM leaver_record WHERE staff_profile_id = $1",
      [FILES.carer],
    );
    expect(leaving?.leaving_on).toBe(ukDay(3));
    entry.leavingDate = null;
  });
});

describe("hazard HZ-133 out-of-date data is said, never hidden (rule 9)", () => {
  it("shows the link as stale once the last good sync is older than the limit", async () => {
    const fresh = (await (await get("/v1/integrations/hr-link")).json()) as {
      staleness: { stale: boolean; lastErrorCode: string | null; failures: number };
    };
    expect(fresh.staleness).toMatchObject({ stale: false, lastErrorCode: null, failures: 0 });
    await owner(
      "UPDATE hr_sync_state SET last_good_sync_at = now() - interval '16 minutes' WHERE kind = 'employees'",
    );
    const stale = (await (await get("/v1/integrations/hr-link")).json()) as {
      staleness: { stale: boolean };
    };
    expect(stale.staleness.stale).toBe(true);
    await send("POST", "/v1/integrations/hr-link/sync", "manager");
  });
});

describe("hazard HZ-133 the match review queue", () => {
  type Match = {
    id: string;
    version: number;
    hrEmployeeId: string;
    hrName: string | null;
    leavingOn: string | null;
  };
  const matches = async () =>
    ((await (await get("/v1/integrations/hr-link/matches")).json()) as { items: Match[] }).items;

  it("shows each employee to review with Thapsus-HR's name, read now, never stored", async () => {
    const items = await matches();
    expect(items.map((m) => m.hrEmployeeId).sort()).toEqual(["emp_conflict", "emp_name_only"]);
    expect(items.find((m) => m.hrEmployeeId === "emp_name_only")?.hrName).toBe("Cat Carer");
  });

  it("never lets a reviewer confirm a match to their own staff file", async () => {
    const item = (await matches()).find((m) => m.hrEmployeeId === "emp_conflict");
    const r = await send(
      "POST",
      `/v1/integrations/hr-link/matches/${item?.id}/confirm`,
      "manager",
      {
        staffProfileId: FILES.manager,
        expectedVersion: item?.version,
      },
    );
    expect(r.status).toBe(403);
    expect(await codeOf(r)).toBe("hr_link_own_file");
  });

  it("refuses a staff file already linked, and a stale version", async () => {
    const item = (await matches()).find((m) => m.hrEmployeeId === "emp_name_only");
    const taken = await send(
      "POST",
      `/v1/integrations/hr-link/matches/${item?.id}/confirm`,
      "manager",
      {
        staffProfileId: FILES.carer,
        expectedVersion: item?.version,
      },
    );
    expect(taken.status).toBe(409);
    const stale = await send(
      "POST",
      `/v1/integrations/hr-link/matches/${item?.id}/confirm`,
      "manager",
      {
        staffProfileId: FILES.spare,
        expectedVersion: (item?.version ?? 0) + 5,
      },
    );
    expect(stale.status).toBe(409);
  });

  it("keeps a reviewed employee's leaving date on the queue, applied only once a manager confirms", async () => {
    const entry = mock.employeesById.get("emp_name_only") as unknown as Record<string, unknown>;
    entry.leavingDate = ukDay(-1);
    await send("POST", "/v1/integrations/hr-link/sync", "manager");
    const [first] = await matches();
    expect(first).toMatchObject({ hrEmployeeId: "emp_name_only", leavingOn: ukDay(-1) });
    const [before] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [SPARE_MEMBER],
    );
    expect(before?.status).toBe("active");
  });

  it("refuses a confirmation with a stale step-up", async () => {
    const item = (await matches()).find((m) => m.hrEmployeeId === "emp_name_only");
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(h.db.pool("harbour_auth"), session, 3_600);
    try {
      const r = await send(
        "POST",
        `/v1/integrations/hr-link/matches/${item?.id}/confirm`,
        "manager",
        { staffProfileId: FILES.spare, expectedVersion: item?.version },
      );
      expect(r.status).toBe(403);
    } finally {
      await ageSession(h.db.pool("harbour_auth"), session, 0);
    }
  });

  it("confirms one in the reviewer's own name and rejects another", async () => {
    const items = await matches();
    const named = items.find((m) => m.hrEmployeeId === "emp_name_only");
    const conflict = items.find((m) => m.hrEmployeeId === "emp_conflict");
    expect(
      (
        await send("POST", `/v1/integrations/hr-link/matches/${named?.id}/confirm`, "manager", {
          staffProfileId: FILES.spare,
          expectedVersion: named?.version,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await send("POST", `/v1/integrations/hr-link/matches/${conflict?.id}/reject`, "manager", {
          expectedVersion: conflict?.version,
        })
      ).status,
    ).toBe(204);
    const [row] = await owner<{ confirmed_by: string; match_method: string }>(
      "SELECT confirmed_by, match_method FROM hr_person_link WHERE id = $1",
      [named?.id],
    );
    expect(row).toEqual({ confirmed_by: DEMO.users.manager.id, match_method: "manual" });
    expect(await matches()).toEqual([]);
    // The leaving date Thapsus-HR gave applies now (rule 8).
    const [member] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [SPARE_MEMBER],
    );
    expect(member?.status).toBe("left");
  });
});

describe("hazard HZ-133 the signed webhook (section 11.6)", () => {
  const event = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      type: "employee.terminated",
      employeeId: "emp_name_only",
      occurredAt: new Date().toISOString(),
      ...over,
    });

  it("refuses an unsigned, wrongly signed or replayed body, keeping nothing", async () => {
    const body = event();
    expect((await webhook(body)).status).toBe(401);
    expect((await webhook(body, sign(body, undefined, "another secret"))).status).toBe(401);
    expect((await webhook(body, sign(body, Math.floor(Date.now() / 1000) - 301))).status).toBe(401);
    expect((await webhook(body, sign(`${body} `))).status).toBe(401);
    const otherTenant = "0199f100-0000-7000-8000-0000000000ff";
    expect((await webhook(body, sign(body), otherTenant)).status).toBe(401);
    expect(
      await owner("SELECT 1 FROM integration_inbound WHERE port = 'integrations.hr_link'"),
    ).toHaveLength(0);
  });

  it("keeps nothing and asks Thapsus-HR to send again when the employee cannot be fetched", async () => {
    const body = event({ id: "evt_retry1", employeeId: "emp_carer" });
    mock.callsLeft = 0;
    try {
      expect((await webhook(body, sign(body))).status).toBe(503);
    } finally {
      mock.callsLeft = Number.POSITIVE_INFINITY;
    }
    expect(
      await owner("SELECT 1 FROM integration_inbound WHERE external_id = 'evt_retry1'"),
    ).toHaveLength(0);
  });

  it("fetches the employee a good webhook names and applies a leaving date at once", async () => {
    const entry = mock.employeesById.get("emp_carer") as unknown as Record<string, unknown>;
    entry.leavingDate = ukDay(2);
    const body = event({ employeeId: "emp_carer" });
    const r = await webhook(body, sign(body));
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ status: "accepted" });
    const [file] = await owner<{ left_on: string }>(
      "SELECT to_char(left_on, 'YYYY-MM-DD') AS left_on FROM staff_profile WHERE id = $1",
      [FILES.carer],
    );
    expect(file?.left_on).toBe(ukDay(2));
    const again = await webhook(body, sign(body));
    expect(await again.json()).toEqual({ status: "duplicate" });
    entry.leavingDate = null;
  });

  it("quarantines a signed body that is not an identifiers-only event, keeping none of it", async () => {
    const body = JSON.stringify({
      id: "evt_bad1",
      type: "employee.terminated",
      name: "Ada Example",
    });
    const r = await webhook(body, sign(body));
    expect(await r.json()).toEqual({ status: "quarantined" });
    const [row] = await owner<{ payload: unknown; status: string }>(
      "SELECT payload, status FROM integration_inbound WHERE external_id = 'evt_bad1'",
    );
    expect(row).toEqual({ payload: { invalid: true }, status: "quarantined" });
  });
});

describe("hazard HZ-133 a starter hired here is created in Thapsus-HR once, with its fields only (rules 4 and 5)", () => {
  it("sends the starter's listed fields, links the staff file, and never sends twice", async () => {
    const before = mock.writes.length;
    const path = `/v1/integrations/hr-link/starters/${FILES.starter}`;
    const names = { givenName: "Sam", familyName: "Starter" };
    const first = (await (await send("POST", path, "manager", names)).json()) as {
      state: string;
      hrId: string;
    };
    expect(first.state).toBe("sent");
    const second = (await (await send("POST", path, "manager", names)).json()) as {
      hrId: string;
    };
    expect(second.hrId).toBe(first.hrId);
    expect(mock.writes.length).toBe(before + 1);
    const sent = mock.writes.at(-1)?.body as Record<string, unknown>;
    expect(
      Object.keys(sent).every((k) => (OUTBOUND_FIELDS.starter as readonly string[]).includes(k)),
    ).toBe(true);
    const [link] = await owner<{ match_method: string; hr_employee_id: string }>(
      "SELECT match_method, hr_employee_id FROM hr_person_link WHERE staff_profile_id = $1 AND state = 'linked'",
      [FILES.starter],
    );
    expect(link).toEqual({ match_method: "starter", hr_employee_id: first.hrId });
    expect((await send("POST", path, "carer", names)).status).toBe(403);
    const linked = await send(
      "POST",
      `/v1/integrations/hr-link/starters/${FILES.leaver}`,
      "manager",
      names,
    );
    expect(linked.status).toBe(409);
    const own = await send(
      "POST",
      `/v1/integrations/hr-link/starters/${FILES.manager}`,
      "manager",
      names,
    );
    expect(own.status).toBe(403);
  });
});

describe("INTG-014 owners, locations, deliveries and disconnecting", () => {
  const status = async () =>
    (await (await get("/v1/integrations/hr-link")).json()) as { version: number };

  it("refuses moving the rota or care-specific records to Thapsus-HR, and a stale version", async () => {
    const { version } = await status();
    const moved = await send("PATCH", "/v1/integrations/hr-link", "manager", {
      expectedVersion: version,
      owners: {
        employee_record: "thapsus_hr",
        leavers: "thapsus_hr",
        pay_rates_and_periods: "thapsus_hr",
        leave_and_sickness: "thapsus_hr",
        care_shifts: "thapsus_hr",
        clocking: "harbour",
        timesheets_and_pay_units: "harbour",
        recruitment_and_vetting: "harbour",
        training_and_competence: "harbour",
      },
    });
    expect(moved.status).toBe(422);
    const tooLong = await send("PATCH", "/v1/integrations/hr-link", "manager", {
      expectedVersion: version,
      stalenessMinutes: 61,
    });
    expect(tooLong.status).toBe(422);
    const stale = await send("PATCH", "/v1/integrations/hr-link", "manager", {
      expectedVersion: version - 1,
      stalenessMinutes: 30,
    });
    expect(stale.status).toBe(409);
    const ok = await send("PATCH", "/v1/integrations/hr-link", "manager", {
      expectedVersion: version,
      stalenessMinutes: 30,
    });
    expect(ok.status).toBe(200);
  });

  it("maps a location to one Thapsus-HR knows, and refuses one it does not", async () => {
    mock.locationsList.push({ id: "loc_main", name: "Main house" });
    const path = `/v1/integrations/hr-link/locations/${DEMO.locationId}`;
    expect((await send("PUT", path, "manager", { hrLocationId: "loc_unknown" })).status).toBe(422);
    expect((await send("PUT", path, "manager", { hrLocationId: "loc_main" })).status).toBe(204);
    const map = (await (await get("/v1/integrations/hr-link/locations")).json()) as {
      harbour: { locationId: string; hrLocationId: string | null }[];
    };
    expect(map.harbour.find((l) => l.locationId === DEMO.locationId)?.hrLocationId).toBe(
      "loc_main",
    );
  });

  it("lists deliveries for readers", async () => {
    const r = (await (await get("/v1/integrations/hr-link/deliveries")).json()) as {
      items: { kind: string; state: string }[];
    };
    expect(r.items).toEqual([expect.objectContaining({ kind: "starter", state: "sent" })]);
  });

  it("is reconciled by the scheduled job, which records the last good sync", async () => {
    await owner("UPDATE hr_sync_state SET last_good_sync_at = now() - interval '2 hours'");
    mock.employeesById.set("emp_job", {
      id: "emp_job",
      ...employee({ workEmail: DEMO.users.nurse.email, dateOfBirth: "1970-01-01" }),
    } as never);
    await syncHrLinks(
      {
        workerPool: h.db.pool("harbour_worker"),
        appDb: h.handle.services.db,
        logger: createLogger("silent"),
        hrLink: h.handle.services.hrLink,
      },
      new Date(),
    );
    const [state] = await owner<{ fresh: boolean }>(
      "SELECT last_good_sync_at > now() - interval '1 minute' AS fresh FROM hr_sync_state WHERE kind = 'employees'",
    );
    expect(state?.fresh).toBe(true);
    expect(
      await owner("SELECT 1 FROM hr_person_link WHERE hr_employee_id = 'emp_job'"),
    ).toHaveLength(1);
  });

  it("tells, and never acts, when Thapsus-HR stops listing a linked employee", async () => {
    mock.employeesById.delete("emp_returned");
    await send("POST", "/v1/integrations/hr-link/sync", "manager");
    expect(
      await owner(
        "SELECT 1 FROM outbox_event WHERE event_type = 'integrations.hr_link.employee_missing'",
      ),
    ).not.toHaveLength(0);
  });

  it("disconnects, keeping the links, after which nothing syncs", async () => {
    expect((await send("DELETE", "/v1/integrations/hr-link", "manager")).status).toBe(204);
    expect((await send("POST", "/v1/integrations/hr-link/sync", "manager")).status).toBe(404);
    expect((await owner("SELECT 1 FROM hr_person_link")).length).toBeGreaterThan(0);
    const body = JSON.stringify({
      id: "evt_after",
      type: "employee.changed",
      employeeId: "emp_carer",
      occurredAt: new Date().toISOString(),
    });
    expect((await webhook(body, sign(body))).status).toBe(401);
  });
});

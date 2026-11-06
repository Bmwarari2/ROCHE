import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockThapsusHr } from "../src/integrations/thapsus-hr";
import { ageSession, createHarness, type Harness, markSessionsVerified } from "./support/harness";

/**
 * Withdrawing a wrong leaving date from Thapsus-HR, and alerts raised once (INTG-014;
 * integrations.md section 11.5 rule 8; slice 88 part A; hazard HZ-133). Invented people only.
 */

let h: Harness;
let mock: MockThapsusHr;
const T = DEMO.tenantId;
const PROJECT = "harbour-test-78";
const SECRET_REF = `projects/${PROJECT}/locations/europe-west2/secrets/harbour_int_${T}_thapsus-hr-webhook`;
const DOMAIN = "thapsus.example.invalid";
const BASE = `https://api.uk.${DOMAIN}`;
const STAYER = "0199f200-0000-7000-8000-000000000001";
const LEAVER = "0199f200-0000-7000-8000-000000000002";
const STAYER_MEMBER = "0199f200-0000-7000-8000-000000000011";
const LEAVER_MEMBER = "0199f200-0000-7000-8000-000000000012";

const as = (who: string) => ({ token: h.tokens[who], tenant: T });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;
const sync = () => send("POST", "/v1/integrations/hr-link/sync", "manager");
const withdraw = (file: string, who = "manager") =>
  send("POST", `/v1/integrations/hr-link/leavers/${file}/withdraw`, who, {
    reason: "date_entered_in_error",
  });
const ukDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Europe/London",
  });

async function owner<R = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [T],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as R[];
  } finally {
    client.release();
  }
}

const employee = (id: string, email: string, dob: string, leavingDate: string | null) => ({
  id,
  employeeNumber: null,
  workEmail: email,
  dateOfBirth: dob,
  givenName: "Ada",
  familyName: "Example",
  leavingDate,
});

beforeAll(async () => {
  h = await createHarness({ GCP_PROJECT_ID: PROJECT, THAPSUS_HR_DOMAIN: DOMAIN });
  await owner(
    "INSERT INTO feature_flag (flag_key, enabled) VALUES ('integrations.thapsus_hr', true)",
  );
  await owner(
    `INSERT INTO tenant_user (id, display_name, email, status) VALUES
       ($1, 'Sid Stayer', 'sid.stayer@example.invalid', 'active'),
       ($2, 'Lou Leaver', 'lou.leaver@example.invalid', 'active')`,
    [STAYER_MEMBER, LEAVER_MEMBER],
  );
  await owner(
    "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) SELECT $1, id, $2 FROM role WHERE key = 'care_worker'",
    [LEAVER_MEMBER, DEMO.locationId],
  );
  // An acting-up role due to end in a month: it keeps that end if access comes back (HZ-124).
  await owner(
    "INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_to) SELECT $1, id, $2, now() + interval '30 days' FROM role WHERE key = 'team_leader'",
    [LEAVER_MEMBER, DEMO.locationId],
  );
  await owner(
    `INSERT INTO staff_profile (id, tenant_user_id, job_title, date_of_birth, starts_on) VALUES
       ($1, $3, 'Care worker', '1990-01-02', '2024-01-08'),
       ($2, $4, 'Care worker', '1991-02-03', '2024-02-05')`,
    [STAYER, LEAVER, STAYER_MEMBER, LEAVER_MEMBER],
  );
  mock = new MockThapsusHr({ slug: "demo-care", homeRegion: "uk", apiBaseUrl: BASE }, BASE);
  h.handle.services.hrLink.mocks.set(T, mock);
  mock.employeesById.set(
    "emp_stayer",
    employee("emp_stayer", "sid.stayer@example.invalid", "1990-01-02", ukDay(5)) as never,
  );
  mock.employeesById.set(
    "emp_leaver",
    employee("emp_leaver", "lou.leaver@example.invalid", "1991-02-03", ukDay(-2)) as never,
  );
  const r = await send("POST", "/v1/integrations/hr-link", "manager", {
    workspaceSlug: "demo-care",
    secretRef: SECRET_REF,
  });
  expect(r.status).toBe(201);
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-133 a wrong leaving date is withdrawn by a person, never while Thapsus-HR still sends it (rule 8)", () => {
  it("refuses while Thapsus-HR still gives the date, raising it for review once", async () => {
    const r = await withdraw(STAYER);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("hr_link_leaving_still_sent");
    await withdraw(STAYER);
    const tasks = await owner(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.leaving_still_sent' AND status = 'open'",
    );
    expect(tasks).toHaveLength(1);
  });

  it("refuses someone without the staff file's manage permission, and a stale step-up", async () => {
    expect((await withdraw(STAYER, "carer")).status).toBe(403);
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(h.db.pool("harbour_auth"), session, 3_600);
    try {
      expect((await withdraw(STAYER)).status).toBe(403);
    } finally {
      await ageSession(h.db.pool("harbour_auth"), session, 0);
    }
  });

  it("withdraws a future leaving once Thapsus-HR no longer gives it, and a later one applies again", async () => {
    const entry = mock.employeesById.get("emp_stayer") as unknown as Record<string, unknown>;
    entry.leavingDate = null;
    const r = await withdraw(STAYER);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ withdrawn: true, accessRestored: false });
    const [file] = await owner<{ left_on: string | null }>(
      "SELECT left_on FROM staff_profile WHERE id = $1",
      [STAYER],
    );
    expect(file?.left_on).toBeNull();
    const live = await owner(
      "SELECT 1 FROM leaver_record WHERE staff_profile_id = $1 AND deleted_at IS NULL",
      [STAYER],
    );
    expect(live).toHaveLength(0);
    // Thapsus-HR gives a leaving again: it applies with the date given now.
    entry.leavingDate = ukDay(9);
    await sync();
    const [again] = await owner<{ leaving_on: string }>(
      "SELECT to_char(leaving_on, 'YYYY-MM-DD') AS leaving_on FROM leaver_record WHERE staff_profile_id = $1 AND deleted_at IS NULL",
      [STAYER],
    );
    expect(again?.leaving_on).toBe(ukDay(9));
  });

  it("gives back sign-in and roles after access ended, only through someone who manages members", async () => {
    const [before] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [LEAVER_MEMBER],
    );
    expect(before?.status).toBe("left");
    const entry = mock.employeesById.get("emp_leaver") as unknown as Record<string, unknown>;
    entry.leavingDate = null;
    // Someone who manages staff files but not members.
    await owner(
      `WITH r AS (INSERT INTO role (key, name, scope_kind, permissions)
         VALUES ('staff_files_only', 'Staff files only', 'tenant', '{workforce.staff_file.manage}')
         RETURNING id)
       INSERT INTO role_assignment (tenant_user_id, role_id) SELECT $1, id FROM r`,
      [DEMO.users.nurse.id],
    );
    await h.db
      .pool("harbour_auth")
      .query(
        "UPDATE auth.user SET two_factor_enabled = true, email_verified = true WHERE email = $1",
        [DEMO.users.nurse.email],
      );
    await markSessionsVerified(h.db.pool("harbour_auth"));
    const filesOnly = await withdraw(LEAVER, "nurse");
    expect(filesOnly.status).toBe(403);
    expect(await codeOf(filesOnly)).toBe("hr_link_needs_user_manager");
    // The Registered Manager manages members at their home only: across the organisation, the owner.
    const home = await withdraw(LEAVER);
    expect(await codeOf(home)).toBe("hr_link_needs_user_manager");
    const r = await withdraw(LEAVER, "owner");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ withdrawn: true, accessRestored: true });
    const [after] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [LEAVER_MEMBER],
    );
    expect(after?.status).toBe("active");
    const roles = await owner(
      "SELECT 1 FROM role_assignment WHERE tenant_user_id = $1 AND valid_to IS NULL AND deleted_at IS NULL",
      [LEAVER_MEMBER],
    );
    expect(roles).toHaveLength(1);
    const boxed = await owner<{ ends: boolean }>(
      "SELECT valid_to > now() + interval '29 days' AS ends FROM role_assignment ra JOIN role r ON r.id = ra.role_id WHERE ra.tenant_user_id = $1 AND r.key = 'team_leader' AND ra.reason = 'Leaving withdrawn'",
      [LEAVER_MEMBER],
    );
    expect(boxed).toEqual([{ ends: true }]);
    const audit = await owner<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE action = 'integrations.hr_link.leaving_withdrawn' AND resource_id = $1",
      [LEAVER],
    );
    expect(audit).toEqual([{ reason: "date_entered_in_error" }]);
  });

  it("ends access again when Thapsus-HR gives a reinstated member a real leaving, and says so once", async () => {
    const entry = mock.employeesById.get("emp_leaver") as unknown as Record<string, unknown>;
    entry.leavingDate = ukDay(-1);
    await sync();
    await sync();
    const tasks = await owner<{ priority: string }>(
      "SELECT priority FROM task WHERE kind = 'integrations.hr_link.leaving_resent' AND status = 'open'",
    );
    expect(tasks).toEqual([{ priority: "urgent" }]);
    const [member] = await owner<{ status: string }>(
      "SELECT status FROM tenant_user WHERE id = $1",
      [LEAVER_MEMBER],
    );
    expect(member?.status).toBe("left");
    const live = await owner(
      "SELECT 1 FROM role_assignment WHERE tenant_user_id = $1 AND (valid_to IS NULL OR valid_to > now()) AND deleted_at IS NULL",
      [LEAVER_MEMBER],
    );
    expect(live).toHaveLength(0);
  });

  it("refuses when Thapsus-HR can no longer find the employee: the leaving stays", async () => {
    const entry = mock.employeesById.get("emp_stayer") as unknown as Record<string, unknown>;
    entry.leavingDate = ukDay(4);
    await sync();
    const saved = mock.employeesById.get("emp_stayer");
    mock.employeesById.delete("emp_stayer");
    try {
      const r = await withdraw(STAYER);
      expect(r.status).toBe(409);
      expect(await codeOf(r)).toBe("hr_link_leaving_still_sent");
    } finally {
      if (saved) mock.employeesById.set("emp_stayer", saved);
    }
  });

  it("never withdraws a leaving recorded here rather than from Thapsus-HR", async () => {
    const MANUAL = "0199f200-0000-7000-8000-000000000003";
    const MANUAL_MEMBER = "0199f200-0000-7000-8000-000000000013";
    await owner(
      "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Mel Manual', 'mel.manual@example.invalid', 'active')",
      [MANUAL_MEMBER],
    );
    await owner(
      "INSERT INTO staff_profile (id, tenant_user_id, job_title, starts_on) VALUES ($1, $2, 'Care worker', '2024-01-08')",
      [MANUAL, MANUAL_MEMBER],
    );
    await owner(
      "INSERT INTO leaver_record (staff_profile_id, leaving_on, reason, created_by) VALUES ($1, $2, 'dismissal', $3)",
      [MANUAL, ukDay(-1), DEMO.users.manager.id],
    );
    const r = await withdraw(MANUAL);
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("hr_link_leaving_not_from_link");
  });
});

describe("hazard HZ-133 an alert is raised once per cause and updated, never re-raised each pull", () => {
  it("keeps one open task for an employee Thapsus-HR stops listing, counting the pulls", async () => {
    mock.employeesById.delete("emp_stayer");
    await sync();
    await sync();
    await sync();
    const tasks = await owner<{ details: { seen: number } }>(
      "SELECT details FROM task WHERE kind = 'integrations.hr_link.employee_missing' AND status = 'open'",
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.details.seen).toBe(3);
    const events = await owner(
      "SELECT 1 FROM outbox_event WHERE event_type = 'integrations.hr_link.employee_missing'",
    );
    expect(events).toHaveLength(1);
  });
});

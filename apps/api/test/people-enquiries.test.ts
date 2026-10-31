import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  type AdmissionDecisionItem,
  type EnquiryRecorded,
  type PersonStatusChangeResult,
  type PersonSummary,
  type PreAdmissionView,
  type ProblemDetails,
  type ServiceList,
  TENANT_HEADER,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { PRE_ADMISSION_SECTIONS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { loadConfig } from "../src/config";
import { createLogger, loggableError } from "../src/logger";
import { createHarness, type Harness, LODGE, PASSWORD } from "./support/harness";

/**
 * Enquiries and the services at a location (people.md rule 1; the start of PEOP-004), which the
 * pre-admission and admission screens need: a new person record at `enquiry` for a manager who
 * manages enquiries where it is about, refused elsewhere (HZ-011), sent again safely with its id
 * (HZ-029) and never answered with anyone's details: an id that is not the caller's own enquiry
 * with the same details is refused and audited (HZ-001), dates are bounded, and an unexpected
 * failure logs no name or date. Then on to the assessment and a decision to admit.
 */

let h: Harness;
/** A receptionist (the administrator role) at Harbour House: enquiries, no care records, no MFA. */
const ADMIN_ID = "0194d000-0000-7000-8000-000000000391";
const ADA = "0194d000-0000-7000-8600-000000000001";

async function ownerQuery(sql: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  h = await createHarness();
  // The administrator role, signed in as the mobile app does (a bearer token), with no second
  // factor: it may record enquiries and must never read a care record through this route.
  await ownerQuery(
    `INSERT INTO tenant_user (id, display_name, email, status)
     VALUES ($1, 'Ari Admin', 'admin@example.invalid', 'invited')`,
    [ADMIN_ID],
  );
  await ownerQuery(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
     SELECT $1, id, $2, 'Test' FROM role WHERE key = 'administrator'`,
    [ADMIN_ID, DEMO.locationId],
  );
  const signUp = await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email: "admin@example.invalid", password: PASSWORD, name: "Ari Admin" },
  });
  const { user } = (await signUp.json()) as { user: { id: string } };
  await ownerQuery("UPDATE tenant_user SET auth_user_id = $1, status = 'active' WHERE id = $2", [
    user.id,
    ADMIN_ID,
  ]);
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email: "admin@example.invalid", password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  h.tokens.admin = signIn.headers.get("set-auth-token") ?? "";
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (user: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const code = async (response: Response) => (await json<ProblemDetails>(response)).code;

const newId = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};

const enquiry = (extra: Record<string, unknown> = {}) => ({
  locationId: DEMO.locationId,
  givenName: "Ivy",
  familyName: "Enquiry",
  dateOfBirth: "1941-06-07",
  ...extra,
});

const post = (user: string, body: object) => as(user, "/v1/people", { method: "POST", body });

async function audits(action: string, resourceId: string, outcome = "success") {
  const { rows } = await ownerQuery(
    `SELECT reason FROM audit_event WHERE action = $1 AND resource_id = $2 AND outcome = $3`,
    [action, resourceId, outcome],
  );
  return rows as { reason: string | null }[];
}

describe("POST /v1/people (an enquiry)", () => {
  it("records a person at enquiry, dated when it came in, and answers with ids and state only", async () => {
    const receivedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const response = await post("manager", enquiry({ preferredName: "  Ivy-May ", receivedAt }));
    expect(response.status).toBe(201);
    const text = await response.text();
    const recorded = JSON.parse(text) as EnquiryRecorded;
    expect(recorded).toMatchObject({
      status: "enquiry",
      locationId: DEMO.locationId,
      statusChangedAt: receivedAt,
      replayed: false,
    });
    // No name or date of birth comes back: the caller already has them.
    expect(text).not.toContain("Ivy");
    expect(text).not.toContain("1941-06-07");
    const person = await json<PersonSummary>(await as("manager", `/v1/people/${recorded.id}`));
    expect(person).toMatchObject({
      givenName: "Ivy",
      familyName: "Enquiry",
      preferredName: "Ivy-May",
      dateOfBirth: "1941-06-07",
      nhsNumber: null,
      allergyStatus: "unknown",
      communicationNeedsStatus: "not_recorded",
    });
    expect(await audits("people.person.enquiry", recorded.id)).toHaveLength(1);
  });

  it("hazard HZ-029 returns the first copy when the same request is sent again with its id", async () => {
    const id = newId();
    const body = enquiry({ id, receivedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const first = await post("manager", body);
    expect(first.status).toBe(201);
    const again = await post("manager", body);
    expect(again.status).toBe(201);
    expect(await json<EnquiryRecorded>(again)).toMatchObject({ id, replayed: true });
    expect(await audits("people.person.enquiry", id)).toHaveLength(1);
    expect(await audits("people.person.enquiry.replay", id)).toHaveLength(1);
  });

  it("hazard HZ-001 refuses the same id with other details (409), changing nothing", async () => {
    const id = newId();
    expect((await post("manager", enquiry({ id }))).status).toBe(201);
    const other = await post("manager", enquiry({ id, givenName: "Iris" }));
    expect(other.status).toBe(409);
    expect(await code(other)).toBe("id_reused_with_different_details");
    const born = await post("manager", enquiry({ id, dateOfBirth: "1941-06-08" }));
    expect(born.status).toBe(409);
    const person = await json<PersonSummary>(await as("manager", `/v1/people/${id}`));
    expect(person.givenName).toBe("Ivy");
    expect((await audits("people.person.enquiry", id, "denied")).map((a) => a.reason)).toEqual([
      "id_reused_with_different_details",
      "id_reused_with_different_details",
    ]);
  });

  it("hazard HZ-001 refuses a resident's id sent by a receptionist, with nothing about them in the answer", async () => {
    const response = await post(
      "admin",
      enquiry({ id: ADA, givenName: "Ada", familyName: "Example", dateOfBirth: "1938-02-01" }),
    );
    expect(response.status).toBe(422);
    const text = await response.text();
    for (const detail of ["Addie", "9990000018", "Penicillin", "large print", "Room", "active"]) {
      expect(text).not.toContain(detail);
    }
    expect((await audits("people.person.enquiry", ADA, "denied")).map((a) => a.reason)).toEqual([
      "id_in_use",
    ]);
    // The manager, who may read Ada's record, is refused the same way: never a copy of it.
    const manager = await post("manager", enquiry({ id: ADA }));
    expect(manager.status).toBe(422);
    expect(await manager.text()).not.toContain("Addie");
  });

  it("refuses another person's enquiry id, and an id used at a home the caller cannot see", async () => {
    const id = newId();
    expect((await post("manager", enquiry({ id }))).status).toBe(201);
    // The owner sees the record but did not make it.
    expect((await post("owner", enquiry({ id }))).status).toBe(422);
    // An id in use somewhere the caller cannot see reads exactly the same.
    const lodge = newId();
    expect((await post("owner", enquiry({ id: lodge, locationId: LODGE.locationId }))).status).toBe(
      201,
    );
    const hidden = await post("manager", enquiry({ id: lodge }));
    expect(hidden.status).toBe(422);
    expect(await audits("people.person.enquiry", lodge, "denied")).toHaveLength(1);
  });

  it("hazard HZ-011 refuses an enquiry at a home outside the caller's locations as not found, and audits it", async () => {
    const response = await post("manager", enquiry({ locationId: LODGE.locationId }));
    expect(response.status).toBe(404);
    expect(
      (await audits("people.person.enquiry", LODGE.locationId, "denied")).map((a) => a.reason),
    ).toContain("outside_scope");
    // The owner works everywhere.
    expect((await post("owner", enquiry({ locationId: LODGE.locationId }))).status).toBe(201);
  });

  it("is only for holders of people.enquiry.manage", async () => {
    expect((await post("nurse", enquiry())).status).toBe(403);
    const carer = await post("carer", enquiry());
    expect(carer.status).toBe(403);
    expect(await code(carer)).toBe("missing_permission");
  });

  it.each<[string, Record<string, unknown>]>([
    ["a time in the future", { receivedAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ["a birth in the future", { dateOfBirth: "2999-01-01" }],
    ["a birth in year 0", { dateOfBirth: "0000-01-01" }],
    ["a birth before 1900", { dateOfBirth: "1899-12-31" }],
    ["an enquiry before 1900", { receivedAt: "1899-12-31T12:00:00Z" }],
    ["an enquiry before the birth", { receivedAt: "1941-06-06T12:00:00Z" }],
    ["a blank name", { givenName: "   " }],
  ])("refuses %s (422)", async (_label, extra) => {
    const response = await post("manager", enquiry(extra));
    expect(response.status).toBe(422);
    expect(await code(response)).toBe("invalid");
  });

  it("accepts the first day of 1900 and an enquiry on the day of birth", async () => {
    expect((await post("manager", enquiry({ dateOfBirth: "1900-01-01" }))).status).toBe(201);
    expect(
      (
        await post(
          "manager",
          enquiry({ dateOfBirth: "1941-06-07", receivedAt: "1941-06-07T12:00:00Z" }),
        )
      ).status,
    ).toBe(201);
  });

  it("goes on to the pre-admission assessment and a decision to admit", async () => {
    const receivedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const created = await json<EnquiryRecorded>(await post("manager", enquiry({ receivedAt })));
    const services = await json<ServiceList>(
      await as("manager", `/v1/locations/${DEMO.locationId}/services`),
    );
    const nursing = services.items.find((s) => s.serviceType === "nursing");
    expect(nursing).toBeDefined();
    const started = await as("manager", `/v1/people/${created.id}/status`, {
      method: "POST",
      body: {
        to: "pre_admission",
        effectiveAt: new Date(Date.now() - 86_400_000).toISOString(),
        serviceId: nursing?.id,
        placementTypeSought: "permanent",
        version: created.version,
      },
    });
    expect(started.status).toBe(200);
    expect((await json<PersonStatusChangeResult>(started)).status).toBe("pre_admission");
    const view = await json<PreAdmissionView>(
      await as("manager", `/v1/people/${created.id}/pre-admission`),
    );
    expect(view.assessment).toMatchObject({
      serviceId: nursing?.id,
      placementTypeSought: "permanent",
    });
    const saved = await as("manager", `/v1/people/${created.id}/pre-admission`, {
      method: "PUT",
      body: {
        sections: Object.fromEntries(
          PRE_ADMISSION_SECTIONS.filter((s) => s.required).map((s) => [
            s.key,
            { status: "complete", notes: "Recorded with Ivy." },
          ]),
        ),
        informationSources: ["person"],
        personInvolvement: { involved: true },
        version: view.assessment?.version ?? 1,
      },
    });
    expect(saved.status).toBe(200);
    const decided = await as("manager", `/v1/people/${created.id}/admission-decisions`, {
      method: "POST",
      body: {
        canMeetNeeds: "yes",
        reasons: "The nursing unit can meet every need the assessment found.",
      },
    });
    expect(decided.status).toBe(201);
    expect((await json<AdmissionDecisionItem>(decided)).admit).toBe(true);
  });
});

describe("an unexpected failure is logged without personal data (section 5.3)", () => {
  it("keeps the error's kind, code and stack frames, never its message", () => {
    const error = Object.assign(
      new Error('Failed query: insert into "person" params: Ada,Example,1938-02-01'),
      { name: "DrizzleQueryError", cause: { code: "22008" } },
    );
    error.stack = `${error.name}: ${error.message}\n    at insert (people-enquiries.ts:10:5)\n    params: Ada`;
    const logged = loggableError(error);
    expect(logged).toEqual({
      type: "DrizzleQueryError",
      code: "22008",
      frames: ["    at insert (people-enquiries.ts:10:5)"],
    });
    expect(JSON.stringify(logged)).not.toMatch(/Ada|Example|1938/);
    expect(loggableError("a string thrown").frames).toEqual([]);
  });

  it("logs no name or date of birth when the insert fails", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const handle = createApp(
      loadConfig({
        NODE_ENV: "test",
        DATABASE_APP_URL: h.db.url("harbour_app"),
        DATABASE_AUTH_URL: h.db.url("harbour_auth"),
        DATABASE_OPERATOR_URL: h.db.url("harbour_operator"),
        LOG_LEVEL: "error",
        LOCAL_DOCUMENTS_DIR: mkdtempSync(join(tmpdir(), "harbour-documents-")),
      }),
      createLogger("error", sink),
    );
    // A database refusal the route does not expect, for this test's name only.
    await h.db.pool("harbour_owner").query(`
      CREATE FUNCTION app.test_refuse_logcheck() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.given_name = 'Logcheck' THEN
          RAISE EXCEPTION 'refused for the log test' USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_refuse_logcheck BEFORE INSERT ON public.person
        FOR EACH ROW EXECUTE FUNCTION app.test_refuse_logcheck();`);
    try {
      const response = await handle.app.request("/v1/people", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.tokens.manager}`,
          [TENANT_HEADER]: DEMO.tenantId,
        },
        body: JSON.stringify(
          enquiry({ givenName: "Logcheck", familyName: "Quietly", dateOfBirth: "1937-03-14" }),
        ),
      });
      expect(response.status).toBe(500);
      const log = lines.join("");
      for (const detail of ["Logcheck", "Quietly", "1937-03-14", "refused for the log test"]) {
        expect(log).not.toContain(detail);
      }
      expect(log).toContain("request failed");
      expect(log).toContain("P0001");
    } finally {
      await h.db.pool("harbour_owner").query(`
        DROP TRIGGER test_refuse_logcheck ON public.person;
        DROP FUNCTION app.test_refuse_logcheck();`);
      await handle.close();
    }
  });
});

describe("GET /v1/locations/{id}/services", () => {
  it("lists the services at a location the caller works at, by name", async () => {
    const response = await as("manager", `/v1/locations/${DEMO.locationId}/services`);
    expect(response.status).toBe(200);
    const { items } = await json<ServiceList>(response);
    expect(items.map((s) => s.name)).toEqual([
      "Harbour House nursing",
      "Harbour House residential",
    ]);
    expect(items.every((s) => s.locationId === DEMO.locationId)).toBe(true);
  });

  it("hazard HZ-011 answers a location outside the caller's access as not found", async () => {
    expect((await as("manager", `/v1/locations/${LODGE.locationId}/services`)).status).toBe(404);
    // A care worker (assigned scope) has no location to choose a service at.
    expect((await as("carer", `/v1/locations/${DEMO.locationId}/services`)).status).toBe(404);
  });
});

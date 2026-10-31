import type {
  AdmissionDecisionItem,
  PersonStatusChangeResult,
  PersonSummary,
  PreAdmissionView,
  ProblemDetails,
  ServiceList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import { PRE_ADMISSION_SECTIONS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Enquiries and the services at a location (people.md rule 1; the start of PEOP-004), which the
 * pre-admission and admission screens need: a new person record at `enquiry` for a manager who
 * manages enquiries where it is about, refused elsewhere (HZ-011), sent again safely with its id,
 * never dated in the future, and on to the pre-admission assessment and a decision to admit.
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
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

async function auditCount(action: string, resourceId: string) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND resource_id = $2",
      [action, resourceId],
    );
    await client.query("COMMIT");
    return rows[0]?.n ?? 0;
  } finally {
    client.release();
  }
}

describe("POST /v1/people (an enquiry)", () => {
  it("records a person at enquiry, dated when it came in, and audits it", async () => {
    const receivedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const response = await as("manager", "/v1/people", {
      method: "POST",
      body: enquiry({ preferredName: "  Ivy-May ", receivedAt }),
    });
    expect(response.status).toBe(201);
    const person = await json<PersonSummary>(response);
    expect(person).toMatchObject({
      status: "enquiry",
      givenName: "Ivy",
      familyName: "Enquiry",
      preferredName: "Ivy-May",
      dateOfBirth: "1941-06-07",
      locationId: DEMO.locationId,
      nhsNumber: null,
      roomLabel: null,
      allergyStatus: "unknown",
      communicationNeedsStatus: "not_recorded",
    });
    expect(person.statusChangedAt).toBe(receivedAt);
    expect(await auditCount("people.person.enquiry", person.id)).toBe(1);
  });

  it("hazard HZ-029 returns the first copy when the same request is sent again with its id", async () => {
    const id = newId();
    const first = await as("manager", "/v1/people", { method: "POST", body: enquiry({ id }) });
    expect(first.status).toBe(201);
    const again = await as("manager", "/v1/people", { method: "POST", body: enquiry({ id }) });
    expect(again.status).toBe(201);
    expect((await json<PersonSummary>(again)).id).toBe(id);
    expect(await auditCount("people.person.enquiry", id)).toBe(1);
    expect(await auditCount("people.person.view", id)).toBe(1);
    // The same id for another home is refused, never a second record.
    const elsewhere = await as("owner", "/v1/people", {
      method: "POST",
      body: enquiry({ id, locationId: LODGE.locationId }),
    });
    expect(elsewhere.status).toBe(422);
  });

  it("hazard HZ-011 refuses an enquiry at a home outside the caller's locations as not found", async () => {
    const response = await as("manager", "/v1/people", {
      method: "POST",
      body: enquiry({ locationId: LODGE.locationId }),
    });
    expect(response.status).toBe(404);
    // The owner works everywhere.
    const owner = await as("owner", "/v1/people", {
      method: "POST",
      body: enquiry({ locationId: LODGE.locationId }),
    });
    expect(owner.status).toBe(201);
  });

  it("is only for holders of people.enquiry.manage", async () => {
    const nurse = await as("nurse", "/v1/people", { method: "POST", body: enquiry() });
    expect(nurse.status).toBe(403);
    const carer = await as("carer", "/v1/people", { method: "POST", body: enquiry() });
    expect(carer.status).toBe(403);
    expect(await code(carer)).toBe("missing_permission");
  });

  it("refuses a time in the future, a birth in the future and missing names", async () => {
    const future = await as("manager", "/v1/people", {
      method: "POST",
      body: enquiry({ receivedAt: new Date(Date.now() + 3_600_000).toISOString() }),
    });
    expect(future.status).toBe(422);
    const born = await as("manager", "/v1/people", {
      method: "POST",
      body: enquiry({ dateOfBirth: "2999-01-01" }),
    });
    expect(born.status).toBe(422);
    const blank = await as("manager", "/v1/people", {
      method: "POST",
      body: enquiry({ givenName: "   " }),
    });
    expect(blank.status).toBe(422);
  });

  it("goes on to the pre-admission assessment and a decision to admit", async () => {
    const receivedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const created = await json<PersonSummary>(
      await as("manager", "/v1/people", { method: "POST", body: enquiry({ receivedAt }) }),
    );
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

import type { ContactList, ContactOut, PersonDetails, ProblemDetails } from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalisePostcode } from "../src/routes/people-details";
import { createHarness, type Harness, OTHER } from "./support/harness";

/**
 * Personal details and contacts through the API (PEOP-001; people.md rule 15): the demographics
 * and the national data opt-out, and key contacts and legal representatives with their evidence
 * and end date. Demo residents 1 to 6 live at Harbour House; the care worker is assigned to
 * residents 1 to 3 and reads only; the Registered Manager changes details. Invented people only.
 */

let h: Harness;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const LEFT = "0194d000-0000-7000-8600-0000000000d1";

beforeAll(async () => {
  h = await createHarness();
  await asDemoTenant((c) =>
    c.query(
      `INSERT INTO person (id, location_id, status, given_name, family_name, date_of_birth,
                           local_identifier, discharged_at, status_changed_at)
       VALUES ($1, $2, 'discharged', 'Lena', 'Leaver', '1937-01-01', 'HH-LEFT-1', now(), now())`,
      [LEFT, DEMO.locationId],
    ),
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown; tenant?: string } = {},
) => h.request(path, { token: h.tokens[user], tenant: init.tenant ?? DEMO.tenantId, ...init });
const json = async <T>(response: Response) => (await response.json()) as T;
const problem = async (response: Response) => json<ProblemDetails>(response);

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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const details = async (n: number) =>
  json<PersonDetails>(await as("manager", `/v1/people/${resident(n)}/details`));

describe("normalisePostcode", () => {
  it.each([
    ["zz99 3zz", "ZZ99 3ZZ"],
    ["ZZ993ZZ", "ZZ99 3ZZ"],
    [" ec1a  1bb ", "EC1A 1BB"],
    ["m1 1ae", "M1 1AE"],
    ["ZZ99", null],
    ["not a postcode", null],
    ["12345", null],
  ])("%s reads as %s", (input, expected) => {
    expect(normalisePostcode(input)).toBe(expected);
  });
});

describe("personal details (PEOP-001)", () => {
  it("returns the demographics and the national data opt-out, audited by id only", async () => {
    const found = await details(6);
    expect(found).toMatchObject({
      personId: resident(6),
      givenName: "Frank",
      familyName: "Dummy",
      nhsNumber: "9990000069",
      dateOfBirth: "1946-01-25",
      nationalDataOptOut: false,
      interpreterRequired: false,
    });
    const audited = await asDemoTenant((c) =>
      c.query(
        "SELECT scope FROM audit_event WHERE action = 'people.person.details_view' AND resource_id = $1",
        [resident(6)],
      ),
    );
    expect(audited.rowCount).toBeGreaterThan(0);
  });

  it("changes only the fields sent, records the opt-out, and keeps the earlier version", async () => {
    const before = await details(6);
    const response = await as("manager", `/v1/people/${resident(6)}/details`, {
      method: "PATCH",
      body: {
        religion: "Quaker",
        postcode: "zz99 3zz",
        nationalDataOptOut: true,
        sexCode: "1",
        ethnicCategoryCode: "99",
        version: before.version,
      },
    });
    expect(response.status).toBe(200);
    const saved = await json<PersonDetails>(response);
    expect(saved).toMatchObject({
      religion: "Quaker",
      postcode: "ZZ99 3ZZ",
      nationalDataOptOut: true,
      sexCode: "1",
      ethnicCategoryCode: "99",
      givenName: "Frank",
      nhsNumber: "9990000069",
      version: before.version + 1,
    });
    // The audit names the fields changed, never their values.
    const audited = await asDemoTenant((c) =>
      c.query(
        "SELECT scope FROM audit_event WHERE action = 'people.person.update' AND resource_id = $1",
        [resident(6)],
      ),
    );
    const scope = audited.rows.at(-1)?.scope as { fields: string[] };
    expect(scope.fields).toEqual([
      "ethnicCategoryCode",
      "nationalDataOptOut",
      "postcode",
      "religion",
      "sexCode",
    ]);
    expect(JSON.stringify(audited.rows)).not.toContain("Quaker");
    // The earlier version stays in the record's history.
    const history = await json<{ versions: { version: number }[] }>(
      await as("manager", `/v1/people/${resident(6)}/history`),
    );
    expect(history.versions.map((v) => v.version)).toContain(before.version);
    // Null clears an optional field; an empty text does too.
    const cleared = await json<PersonDetails>(
      await as("manager", `/v1/people/${resident(6)}/details`, {
        method: "PATCH",
        body: { religion: "", nationalDataOptOut: false, version: saved.version },
      }),
    );
    expect(cleared).toMatchObject({ religion: null, nationalDataOptOut: false });
  });

  it.each([
    [{ nhsNumber: "9990000019" }, "This is not a valid NHS number. Check each digit."],
    [{ nhsNumber: "99900000" }, "An NHS number has 10 digits."],
    [{ nhsNumber: null }, "Give a local identifier when there is no NHS number."],
    [{ nhsNumber: "9990000018" }, "This NHS number is already recorded for someone else"],
    [{ postcode: "ZZ99" }, "Enter a full UK postcode."],
    [{ dateOfBirth: "2999-01-01" }, "A date of birth cannot be in the future."],
  ])("refuses %j in words", async (change, words) => {
    const { version } = await details(5);
    const response = await as("manager", `/v1/people/${resident(5)}/details`, {
      method: "PATCH",
      body: { ...change, version },
    });
    expect(response.status).toBe(422);
    expect((await problem(response)).detail).toContain(words);
    expect((await details(5)).version).toBe(version);
  });

  it("takes an NHS number typed with spaces, and allows none with a local identifier", async () => {
    const { version } = await details(4);
    const spaced = await json<PersonDetails>(
      await as("manager", `/v1/people/${resident(4)}/details`, {
        method: "PATCH",
        body: { nhsNumber: "999 000 0042", version },
      }),
    );
    expect(spaced.nhsNumber).toBe("9990000042");
    const none = await as("manager", `/v1/people/${resident(4)}/details`, {
      method: "PATCH",
      body: { nhsNumber: null, localIdentifier: "HH-0004", version: spaced.version },
    });
    expect(none.status).toBe(200);
    const restored = await as("manager", `/v1/people/${resident(4)}/details`, {
      method: "PATCH",
      body: { nhsNumber: "9990000042", version: spaced.version + 1 },
    });
    expect(restored.status).toBe(200);
  });

  it("refuses a stale version as a conflict, and nothing changes", async () => {
    const { version } = await details(3);
    const response = await as("manager", `/v1/people/${resident(3)}/details`, {
      method: "PATCH",
      body: { religion: "Stale", version: version + 5 },
    });
    expect(response.status).toBe(409);
    expect((await problem(response)).code).toBe("version_conflict");
    expect((await details(3)).religion).toBeNull();
  });

  it("refuses a change with nothing in it", async () => {
    const { version } = await details(3);
    const response = await as("manager", `/v1/people/${resident(3)}/details`, {
      method: "PATCH",
      body: { version },
    });
    expect(response.status).toBe(422);
  });

  it("lets the care worker read the people they are assigned to, never change them", async () => {
    expect((await as("carer", `/v1/people/${resident(1)}/details`)).status).toBe(200);
    const change = await as("carer", `/v1/people/${resident(1)}/details`, {
      method: "PATCH",
      body: { religion: "None", version: 1 },
    });
    expect(change.status).toBe(403);
    expect((await problem(change)).code).toBe("missing_permission");
    // Someone they are not assigned to is not found, as if they did not exist (ADR-0002).
    expect((await as("carer", `/v1/people/${resident(4)}/details`)).status).toBe(404);
    expect((await as("carer", `/v1/people/${resident(4)}/contacts`)).status).toBe(404);
  });

  it("hazard HZ-011 another organisation's manager finds nothing and changes nothing", async () => {
    for (const path of [
      `/v1/people/${resident(1)}/details`,
      `/v1/people/${resident(1)}/contacts`,
    ]) {
      const response = await as("rae", path, { tenant: OTHER.tenantId });
      expect(response.status).toBe(404);
    }
    const { version } = await details(1);
    const change = await as("rae", `/v1/people/${resident(1)}/details`, {
      method: "PATCH",
      tenant: OTHER.tenantId,
      body: { religion: "None", version },
    });
    // Refused before anything is read (their role there does not change details) or not found.
    expect([403, 404]).toContain(change.status);
    expect(await details(1)).toMatchObject({ version, religion: null });
  });

  it("keeps a discharged person's record read-only", async () => {
    const found = await json<PersonDetails>(await as("manager", `/v1/people/${LEFT}/details`));
    expect(found.status).toBe("discharged");
    const change = await as("manager", `/v1/people/${LEFT}/details`, {
      method: "PATCH",
      body: { religion: "None", version: found.version },
    });
    expect(change.status).toBe(422);
    const add = await as("manager", `/v1/people/${LEFT}/contacts`, {
      method: "POST",
      body: { role: "next_of_kin", givenName: "Ivy", familyName: "Leaver" },
    });
    expect(add.status).toBe(422);
  });
});

describe("contacts and representatives (PEOP-001)", () => {
  const contacts = async (n: number) =>
    (await json<ContactList>(await as("manager", `/v1/people/${resident(n)}/contacts`))).items;

  it("lists the next of kin the home already holds", async () => {
    const items = await contacts(2);
    expect(items).toEqual([
      expect.objectContaining({
        role: "next_of_kin",
        givenName: "Relative",
        familyName: "Sample",
        isNextOfKin: true,
        evidenceMissing: false,
        expired: false,
      }),
    ]);
  });

  it("flags an attorney with no reference or evidence until one is recorded", async () => {
    const created = await as("manager", `/v1/people/${resident(2)}/contacts`, {
      method: "POST",
      body: {
        role: "lpa_health_welfare",
        givenName: "Pat",
        familyName: "Attorney",
        relationship: "Niece",
        email: "pat.attorney@example.invalid",
        postcode: "zz99 3zz",
        validUntil: "2099-12-31",
      },
    });
    expect(created.status).toBe(201);
    const lpa = await json<ContactOut>(created);
    expect(lpa).toMatchObject({
      evidenceMissing: true,
      expired: false,
      postcode: "ZZ99 3ZZ",
      isNextOfKin: false,
    });
    const updated = await as("manager", `/v1/people/${resident(2)}/contacts/${lpa.id}`, {
      method: "PATCH",
      body: { authorityReference: "OPG-EXAMPLE-0001", version: lpa.version },
    });
    expect(updated.status).toBe(200);
    expect(await json<ContactOut>(updated)).toMatchObject({
      evidenceMissing: false,
      authorityReference: "OPG-EXAMPLE-0001",
      version: lpa.version + 1,
    });
    const audited = await asDemoTenant((c) =>
      c.query(
        "SELECT scope FROM audit_event WHERE action = 'people.contact.update' AND resource_id = $1",
        [lpa.id],
      ),
    );
    expect(audited.rows[0]?.scope).toEqual({ fields: ["authorityReference"] });
    expect(JSON.stringify(audited.rows)).not.toContain("OPG-EXAMPLE");
    // Its end date passed: shown as ended.
    const ended = await json<ContactOut>(
      await as("manager", `/v1/people/${resident(2)}/contacts/${lpa.id}`, {
        method: "PATCH",
        body: { validUntil: "2020-01-01", version: lpa.version + 1 },
      }),
    );
    expect(ended.expired).toBe(true);
    // A stale version is a conflict.
    const stale = await as("manager", `/v1/people/${resident(2)}/contacts/${lpa.id}`, {
      method: "PATCH",
      body: { phone: "01632 960000", version: lpa.version },
    });
    expect(stale.status).toBe(409);
  });

  it("needs a deputy's order scope, and only a deputy has one", async () => {
    const deputy = await as("manager", `/v1/people/${resident(2)}/contacts`, {
      method: "POST",
      body: { role: "deputy", givenName: "Dee", familyName: "Deputy" },
    });
    expect(deputy.status).toBe(422);
    expect((await problem(deputy)).detail).toBe(
      "Say what the deputy's Court of Protection order covers.",
    );
    const other = await as("manager", `/v1/people/${resident(2)}/contacts`, {
      method: "POST",
      body: {
        role: "advocate",
        givenName: "Ade",
        familyName: "Advocate",
        authorityScope: "both",
      },
    });
    expect(other.status).toBe(422);
    const ok = await as("manager", `/v1/people/${resident(2)}/contacts`, {
      method: "POST",
      body: {
        role: "deputy",
        givenName: "Dee",
        familyName: "Deputy",
        authorityScope: "property_affairs",
        authorityReference: "COP-EXAMPLE-0002",
      },
    });
    expect(ok.status).toBe(201);
  });

  it("refuses evidence filed against another person, and a contact of another person", async () => {
    const [ben] = await contacts(2);
    const elsewhere = await as("manager", `/v1/people/${resident(3)}/contacts/${ben?.id}`, {
      method: "PATCH",
      body: { phone: "01632 960001", version: ben?.version ?? 1 },
    });
    expect(elsewhere.status).toBe(404);
    const evidence = await as("manager", `/v1/people/${resident(2)}/contacts`, {
      method: "POST",
      body: {
        role: "appointee",
        givenName: "Abe",
        familyName: "Appointee",
        authorityDocumentId: "0194d000-0000-7000-8000-00000000dead",
      },
    });
    expect(evidence.status).toBe(422);
  });

  it("lets the care worker read contacts but not add one", async () => {
    expect((await as("carer", `/v1/people/${resident(1)}/contacts`)).status).toBe(200);
    const add = await as("carer", `/v1/people/${resident(1)}/contacts`, {
      method: "POST",
      body: { role: "other", givenName: "Una", familyName: "Other" },
    });
    expect(add.status).toBe(403);
  });
});

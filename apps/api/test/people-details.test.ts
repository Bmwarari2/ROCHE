import type {
  ContactList,
  ContactOut,
  ContactSaved,
  DocumentItem,
  PersonDetails,
  ProblemDetails,
  SharingDecisionList,
  SharingDecisionOut,
  SharingVisibility,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalisePostcode } from "../src/routes/people-details";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Personal details and contacts through the API (PEOP-001; people.md rule 15): the demographics
 * and the national data opt-out, and key contacts and legal representatives with their evidence
 * and end date. Demo residents 1 to 6 live at Harbour House; the care worker is assigned to
 * residents 1 to 3 and reads only; the Registered Manager changes details. Invented people only.
 */

let h: Harness;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const LEFT = "0194d000-0000-7000-8600-0000000000d1";
const LEFT_CONTACT = "0194d000-0000-7000-8700-0000000000d1";
const PORTAL_MEMBER = "0194d000-0000-7000-8000-0000000003d1";
const DAY = 86_400_000;
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

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
  await asDemoTenant((c) =>
    c.query(
      `INSERT INTO contact (id, person_id, role, given_name, family_name)
       VALUES ($1, $2, 'next_of_kin', 'Ivy', 'Leaver')`,
      [LEFT_CONTACT, LEFT],
    ),
  );
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: {
    method?: string;
    body?: unknown;
    tenant?: string;
    raw?: { bytes: Uint8Array; contentType: string };
  } = {},
) => h.request(path, { token: h.tokens[user], tenant: init.tenant ?? DEMO.tenantId, ...init });

/** Files a document about a person, as the manager. */
async function file(personId: string, category: string): Promise<DocumentItem> {
  const response = await as(
    "manager",
    `/v1/documents?${new URLSearchParams({ category, title: "Evidence (example)", personId })}`,
    { method: "POST", raw: { bytes: PDF, contentType: "application/pdf" } },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return json<DocumentItem>(response);
}

/** Ages (or, with 0, refreshes) the manager's sign-in and second factor, for step-up. */
const setManagerSessionAge = (minutes: number) =>
  ageSession(h.db.pool("harbour_auth"), h.tokens.manager?.split(".")[0] ?? "", minutes * 60);
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
    [{ dateOfBirth: "2999-01-01" }, "A date of birth is from 1900 to today."],
  ])("hazard HZ-001 refuses %j in words, changing nothing", async (change, words) => {
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

  it("refuses evidence filed against another person or of the wrong kind, and a contact of another person", async () => {
    const [ben] = await contacts(2);
    const elsewhere = await as("manager", `/v1/people/${resident(3)}/contacts/${ben?.id}`, {
      method: "PATCH",
      body: { phone: "01632 960001", version: ben?.version ?? 1 },
    });
    expect(elsewhere.status).toBe(404);
    const appointee = (authorityDocumentId: string) =>
      as("manager", `/v1/people/${resident(2)}/contacts`, {
        method: "POST",
        body: { role: "appointee", givenName: "Abe", familyName: "Appointee", authorityDocumentId },
      });
    // A real document, filed against someone else.
    const caras = await file(resident(3), "person_document");
    const theirs = await appointee(caras.id);
    expect(theirs.status).toBe(422);
    expect((await problem(theirs)).detail).toBe(
      "The evidence of the authority was not found in this person's documents.",
    );
    // This person's, but a care attachment, never evidence of an authority (#119 review L2).
    const attachment = await file(resident(2), "care_attachment");
    expect((await appointee(attachment.id)).status).toBe(422);
    // A document that does not exist at all.
    expect((await appointee("0194d000-0000-7000-8000-00000000dead")).status).toBe(422);
    // This person's own document about them is taken.
    const own = await file(resident(2), "person_document");
    const added = await appointee(own.id);
    expect(added.status).toBe(201);
    expect(await json<ContactOut>(added)).toMatchObject({
      authorityDocumentId: own.id,
      evidenceMissing: false,
    });
  });

  it("keeps a discharged person's contacts read-only", async () => {
    const change = await as("manager", `/v1/people/${LEFT}/contacts/${LEFT_CONTACT}`, {
      method: "PATCH",
      body: { phone: "01632 960002", version: 1 },
    });
    expect(change.status).toBe(422);
  });

  it("hazard HZ-011 a manager of one home finds nobody at another home of the same organisation", async () => {
    for (const path of [
      `/v1/people/${LODGE.personId}/details`,
      `/v1/people/${LODGE.personId}/contacts`,
    ]) {
      expect((await as("manager", path)).status).toBe(404);
    }
    const change = await as("manager", `/v1/people/${LODGE.personId}/details`, {
      method: "PATCH",
      body: { religion: "None", version: 1 },
    });
    expect(change.status).toBe(404);
    const add = await as("manager", `/v1/people/${LODGE.personId}/contacts`, {
      method: "POST",
      body: { role: "other", givenName: "Una", familyName: "Other" },
    });
    expect(add.status).toBe(404);
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

describe("bounds and control characters (#119 review M2)", () => {
  it.each([
    ["a date of birth in year 0", { dateOfBirth: "0000-01-01" }],
    ["a date of birth in the year 1000", { dateOfBirth: "1000-06-15" }],
    ["a date of birth before 1900", { dateOfBirth: "1899-12-31" }],
    ["a NUL in a name", { givenName: "Fr\u0000ank" }],
    ["an escape character in the religion", { religion: "Quaker\u001b[2J" }],
  ])("refuses %s in the personal details, changing nothing", async (_name, change) => {
    const { version } = await details(6);
    const response = await as("manager", `/v1/people/${resident(6)}/details`, {
      method: "PATCH",
      body: { ...change, version },
    });
    expect(response.status).toBe(422);
    expect((await details(6)).version).toBe(version);
  });

  it.each([
    ["a NUL in the notes", { notes: "Prefers mornings\u0000" }],
    ["an end date in year 1", { validUntil: "0001-01-01" }],
    ["an end date in 9999", { validUntil: "9999-12-31" }],
  ])("refuses %s on a contact", async (_name, change) => {
    const response = await as("manager", `/v1/people/${resident(6)}/contacts`, {
      method: "POST",
      body: { role: "lpa_property_finance", givenName: "Bo", familyName: "Bounds", ...change },
    });
    expect(response.status).toBe(422);
  });

  it("keeps line breaks and tabs in free text", async () => {
    const response = await as("manager", `/v1/people/${resident(6)}/contacts`, {
      method: "POST",
      body: {
        role: "other",
        givenName: "Lin",
        familyName: "Breaks",
        notes: "Calls on Sundays.\nPrefers text.\tAsk first.",
      },
    });
    expect(response.status).toBe(201);
  });
});

describe("hazard HZ-022 a change that takes an authority away suspends the decisions resting on it (#119 review M3)", () => {
  const decisions = async (personId: string) =>
    (
      await json<SharingDecisionList>(
        await as("manager", `/v1/people/${personId}/sharing-decisions`),
      )
    ).items;

  it("suspends a decision on a property and finance attorney's authority when it is cut short, never on a harmless change", async () => {
    const who = resident(3);
    const attorney = await json<ContactOut>(
      await as("manager", `/v1/people/${who}/contacts`, {
        method: "POST",
        body: {
          role: "lpa_property_finance",
          givenName: "Fin",
          familyName: "Attorney",
          authorityReference: "OPG-EXAMPLE-3",
          validUntil: "2099-12-31",
        },
      }),
    );
    const recorded = await as("manager", `/v1/people/${who}/sharing-decisions`, {
      method: "POST",
      body: {
        recipient: { kind: "family", contactId: attorney.id },
        sections: ["finance"],
        basis: "legal_authority",
        authority: { role: "lpa_property_finance", contactId: attorney.id },
        validTo: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    });
    expect(recorded.status, await recorded.clone().text()).toBe(201);
    const decision = await json<SharingDecisionOut>(recorded);
    // The person's own consent to the same contact rests on no authority: never touched.
    const consent = await json<SharingDecisionOut>(
      await as("manager", `/v1/people/${who}/sharing-decisions`, {
        method: "POST",
        body: {
          recipient: { kind: "family", contactId: attorney.id },
          sections: ["activities_and_visits"],
          basis: "consent",
          consentGivenBy: "person",
          validTo: new Date(Date.now() + 30 * DAY).toISOString(),
        },
      }),
    );

    const phone = await json<ContactSaved>(
      await as("manager", `/v1/people/${who}/contacts/${attorney.id}`, {
        method: "PATCH",
        body: { phone: "01632 960003", version: attorney.version },
      }),
    );
    expect(phone.suspendedDecisions).toBe(0);
    expect((await decisions(who)).find((d) => d.id === decision.id)?.inForce).toBe(true);

    const cut = await as("manager", `/v1/people/${who}/contacts/${attorney.id}`, {
      method: "PATCH",
      body: { validUntil: "2027-01-01", version: phone.version },
    });
    expect(cut.status).toBe(200);
    expect((await json<ContactSaved>(cut)).suspendedDecisions).toBe(1);
    const after = await decisions(who);
    const suspended = after.find((d) => d.id === decision.id);
    expect(suspended).toMatchObject({ inForce: false, withdrawnAt: null });
    expect(suspended?.suspendedAt).not.toBeNull();
    expect(suspended?.suspensions).toHaveLength(1);
    expect(after.find((d) => d.id === consent.id)?.inForce).toBe(true);
    const seen = await json<SharingVisibility>(
      await as(
        "manager",
        `/v1/people/${who}/sharing-decisions/visibility?contactId=${attorney.id}`,
      ),
    );
    expect(seen.sections.find((s) => s.section === "finance")).toMatchObject({
      visible: false,
      reason: "suspended",
    });
    const audited = await asDemoTenant((c) =>
      c.query<{ reason: string; scope: { changes: string[] } }>(
        "SELECT reason, scope FROM audit_event WHERE action = 'people.sharing.suspend' AND resource_id = $1",
        [decision.id],
      ),
    );
    expect(audited.rows).toEqual([
      { reason: "authority_changed", scope: { contactId: attorney.id, changes: ["ends_earlier"] } },
    ]);
    const published = await asDemoTenant((c) =>
      c.query(
        "SELECT 1 FROM outbox_event WHERE event_type = 'people.sharing.changed' AND payload->>'decisionId' = $1",
        [decision.id],
      ),
    );
    expect(published.rowCount).toBeGreaterThan(0);
  });

  it("suspends a decision whose holder is no longer an attorney", async () => {
    const who = resident(4);
    const attorney = await json<ContactOut>(
      await as("manager", `/v1/people/${who}/contacts`, {
        method: "POST",
        body: {
          role: "lpa_property_finance",
          givenName: "Rae",
          familyName: "Revoked",
          authorityReference: "OPG-EXAMPLE-4",
        },
      }),
    );
    const decision = await json<SharingDecisionOut>(
      await as("manager", `/v1/people/${who}/sharing-decisions`, {
        method: "POST",
        body: {
          recipient: { kind: "family", contactId: attorney.id },
          sections: ["finance"],
          basis: "legal_authority",
          authority: { role: "lpa_property_finance", contactId: attorney.id },
          validTo: new Date(Date.now() + 30 * DAY).toISOString(),
        },
      }),
    );
    const changed = await json<ContactSaved>(
      await as("manager", `/v1/people/${who}/contacts/${attorney.id}`, {
        method: "PATCH",
        body: { role: "next_of_kin", authorityReference: null, version: attorney.version },
      }),
    );
    expect(changed.suspendedDecisions).toBe(1);
    expect((await decisions(who)).find((d) => d.id === decision.id)?.inForce).toBe(false);
  });
});

describe("a family member's portal email (#119 review L1)", () => {
  it("needs sharing management and a fresh sign-in to change the address a portal account is matched by", async () => {
    const who = resident(5);
    const [relative] = (
      await json<ContactList>(await as("manager", `/v1/people/${who}/contacts`))
    ).items.filter((c) => c.role === "next_of_kin");
    expect(relative).toBeTruthy();
    await asDemoTenant(async (c) => {
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status)
         VALUES ($1, 'Portal Example', 'portal.example@example.invalid', 'active')`,
        [PORTAL_MEMBER],
      );
      await c.query(
        "INSERT INTO family_portal_user (tenant_user_id, person_id, contact_id) VALUES ($1, $2, $3)",
        [PORTAL_MEMBER, who, relative?.id],
      );
    });
    // Anything else about the contact changes as before.
    const phone = await as("manager", `/v1/people/${who}/contacts/${relative?.id}`, {
      method: "PATCH",
      body: { phone: "01632 960004", version: relative?.version },
    });
    expect(phone.status).toBe(200);
    const version = (await json<ContactSaved>(phone)).version;
    await setManagerSessionAge(60);
    try {
      const stale = await as("manager", `/v1/people/${who}/contacts/${relative?.id}`, {
        method: "PATCH",
        body: { email: "someone.else@example.invalid", version },
      });
      expect(stale.status).toBe(403);
      expect((await problem(stale)).code).toBe("step_up_required");
    } finally {
      await setManagerSessionAge(0);
    }
    const refused = await asDemoTenant((c) =>
      c.query(
        "SELECT 1 FROM audit_event WHERE action = 'people.contact.portal_email_change' AND outcome = 'denied'",
      ),
    );
    expect(refused.rowCount).toBe(1);
    const fresh = await as("manager", `/v1/people/${who}/contacts/${relative?.id}`, {
      method: "PATCH",
      body: { email: "someone.else@example.invalid", version },
    });
    expect(fresh.status).toBe(200);
  });
});

describe("hazard HZ-001 hazard HZ-011 an NHS number on a record the caller cannot see (#119 review M1)", () => {
  const LODGE_NHS = "9990000077";
  const attempt = async (nhsNumber: string, user: keyof Harness["tokens"] = "manager") => {
    const { version } = await json<PersonDetails>(
      await as(user, `/v1/people/${resident(5)}/details`),
    );
    return as(user, `/v1/people/${resident(5)}/details`, {
      method: "PATCH",
      body: { nhsNumber, version },
    });
  };

  it("refuses without saying whose or where, audits it without the number, and asks the owner to look for a duplicate", async () => {
    const before = await details(5);
    const refused = await attempt(LODGE_NHS);
    expect(refused.status).toBe(422);
    const words = (await problem(refused)).detail ?? "";
    expect(words).toBe(
      "This NHS number could not be saved for this person. Check it against their documents. A manager has been asked to review it.",
    );
    expect(words).not.toContain("organisation");
    expect(await details(5)).toMatchObject({ version: before.version, nhsNumber: "9990000050" });
    const audited = await asDemoTenant((c) =>
      c.query(
        `SELECT reason, scope FROM audit_event
          WHERE action = 'people.person.update' AND outcome = 'denied' AND resource_id = $1`,
        [resident(5)],
      ),
    );
    expect(audited.rows.map((r) => r.reason)).toEqual(["nhs_number_in_use"]);
    expect(JSON.stringify(audited.rows)).not.toContain(LODGE_NHS);
    const tasks = async () =>
      asDemoTenant((c) =>
        c.query<{ assignee_role_key: string; required_permission: string; title: string }>(
          `SELECT assignee_role_key, required_permission, title FROM task
            WHERE kind = 'people.duplicate_record_review' AND person_id = $1`,
          [resident(5)],
        ),
      );
    expect((await tasks()).rows).toEqual([
      {
        assignee_role_key: "owner",
        required_permission: "people.person.update",
        title: "Check for a duplicate record: an NHS number could not be saved",
      },
    ]);
    // A second refusal raises no second task.
    expect((await attempt(LODGE_NHS)).status).toBe(422);
    expect((await tasks()).rowCount).toBe(1);
  });

  it("says plainly when the holder is someone the caller can see", async () => {
    // The owner works across the organisation and sees both homes.
    const refused = await attempt(LODGE_NHS, "owner");
    expect(refused.status).toBe(422);
    expect((await problem(refused)).detail).toBe(
      "This NHS number is already recorded for someone else in this organisation. Check it.",
    );
  });

  it("stops NHS number changes for an hour after three such refusals, and nothing else", async () => {
    // Two refusals so far in this block; one more reaches the limit.
    expect((await attempt(LODGE_NHS)).status).toBe(422);
    const limited = await attempt("9990000085");
    expect(limited.status).toBe(429);
    expect((await problem(limited)).code).toBe("rate_limited");
    const { version } = await details(5);
    const other = await as("manager", `/v1/people/${resident(5)}/details`, {
      method: "PATCH",
      body: { religion: "None", version },
    });
    expect(other.status).toBe(200);
    // Other members are not limited.
    expect((await attempt("9990000085", "owner")).status).toBe(200);
  });
});

describe("hazard HZ-001 hazard HZ-011 the NHS number limit holds under parallel requests (#119 review round 2)", () => {
  const LODGE_NHS = "9990000077";
  const resetLimit = () =>
    asDemoTenant((c) =>
      c.query(
        "UPDATE request_quota SET hits = '[]'::jsonb WHERE quota = 'people.nhs_number_in_use'",
      ),
    );
  const change = async (nhsNumber: string) => {
    const { version } = await details(5);
    return as("manager", `/v1/people/${resident(5)}/details`, {
      method: "PATCH",
      body: { nhsNumber, version },
    });
  };

  it("gives the count back for anything but a refusal on a record the caller cannot see", async () => {
    await resetLimit();
    // Five refusals on a record the manager can see (Ada's number) count for nothing.
    for (let n = 0; n < 5; n += 1) expect((await change("9990000018")).status).toBe(422);
    const neutral = await change(LODGE_NHS);
    expect(neutral.status).toBe(422);
    expect((await problem(neutral)).detail).toContain("could not be saved for this person");
  });

  it("answers at most three of ten parallel attempts, and refuses the rest before looking", async () => {
    await resetLimit();
    const { version } = await details(5);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        as("manager", `/v1/people/${resident(5)}/details`, {
          method: "PATCH",
          body: { nhsNumber: LODGE_NHS, version },
        }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    const answered = statuses.filter((s) => s === 422).length;
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(3);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10 - answered);
    expect((await details(5)).version).toBe(version);
    await resetLimit();
  });
});

describe("hazard HZ-022 a suspension never lifts onto an authority that has gone (#119 review round 2)", () => {
  it("keeps a decision suspended for a safeguarding enquiry closed once its attorney is no longer one", async () => {
    const who = resident(2);
    const attorney = await json<ContactOut>(
      await as("manager", `/v1/people/${who}/contacts`, {
        method: "POST",
        body: {
          role: "lpa_property_finance",
          givenName: "Sal",
          familyName: "Safeguard",
          authorityReference: "OPG-EXAMPLE-5",
        },
      }),
    );
    const recorded = await json<SharingDecisionOut>(
      await as("manager", `/v1/people/${who}/sharing-decisions`, {
        method: "POST",
        body: {
          recipient: { kind: "family", contactId: attorney.id },
          sections: ["finance"],
          basis: "legal_authority",
          authority: { role: "lpa_property_finance", contactId: attorney.id },
          validTo: new Date(Date.now() + 30 * DAY).toISOString(),
        },
      }),
    );
    const suspend = await as(
      "manager",
      `/v1/people/${who}/sharing-decisions/${recorded.id}/suspend`,
      { method: "POST", body: { reason: "Safeguarding enquiry open", version: recorded.version } },
    );
    expect(suspend.status).toBe(200);
    const suspended = await json<SharingDecisionOut>(suspend);

    // The attorney is changed to someone with no authority while the enquiry runs.
    const changed = await json<ContactSaved>(
      await as("manager", `/v1/people/${who}/contacts/${attorney.id}`, {
        method: "PATCH",
        body: { role: "other", version: attorney.version },
      }),
    );
    expect(changed.suspendedDecisions).toBe(0);
    const noted = await asDemoTenant((c) =>
      c.query(
        "SELECT reason FROM audit_event WHERE action = 'people.sharing.authority_changed' AND resource_id = $1",
        [recorded.id],
      ),
    );
    expect(noted.rows).toEqual([{ reason: "authority_changed" }]);

    // The enquiry closes: lifting is refused, in words, and audited.
    const lift = await as(
      "manager",
      `/v1/people/${who}/sharing-decisions/${recorded.id}/lift-suspension`,
      { method: "POST", body: { reason: "Enquiry closed", version: suspended.version } },
    );
    expect(lift.status).toBe(422);
    expect((await problem(lift)).detail).toBe(
      "The authority this decision rests on has changed or ended since it was recorded. Withdraw the decision and record a new one if sharing should go on.",
    );
    const refused = await asDemoTenant((c) =>
      c.query(
        `SELECT reason FROM audit_event
          WHERE action = 'people.sharing.lift_suspension' AND outcome = 'denied' AND resource_id = $1`,
        [recorded.id],
      ),
    );
    expect(refused.rows).toEqual([{ reason: "authority_changed" }]);
    const items = (
      await json<SharingDecisionList>(await as("manager", `/v1/people/${who}/sharing-decisions`))
    ).items;
    const still = items.find((d) => d.id === recorded.id);
    expect(still).toMatchObject({ inForce: false });
    expect(still?.suspendedAt).not.toBeNull();
    const seen = await json<SharingVisibility>(
      await as(
        "manager",
        `/v1/people/${who}/sharing-decisions/visibility?contactId=${attorney.id}`,
      ),
    );
    expect(seen.sections.find((s) => s.section === "finance")?.visible).toBe(false);
  });

  it("lifts a suspension whose authority still holds", async () => {
    const who = resident(2);
    const attorney = await json<ContactOut>(
      await as("manager", `/v1/people/${who}/contacts`, {
        method: "POST",
        body: {
          role: "lpa_property_finance",
          givenName: "Hal",
          familyName: "Holds",
          authorityReference: "OPG-EXAMPLE-6",
        },
      }),
    );
    const recorded = await json<SharingDecisionOut>(
      await as("manager", `/v1/people/${who}/sharing-decisions`, {
        method: "POST",
        body: {
          recipient: { kind: "family", contactId: attorney.id },
          sections: ["finance"],
          basis: "legal_authority",
          authority: { role: "lpa_property_finance", contactId: attorney.id },
          validTo: new Date(Date.now() + 30 * DAY).toISOString(),
        },
      }),
    );
    const suspended = await json<SharingDecisionOut>(
      await as("manager", `/v1/people/${who}/sharing-decisions/${recorded.id}/suspend`, {
        method: "POST",
        body: { reason: "Safeguarding enquiry open", version: recorded.version },
      }),
    );
    const lift = await as(
      "manager",
      `/v1/people/${who}/sharing-decisions/${recorded.id}/lift-suspension`,
      { method: "POST", body: { reason: "Enquiry closed", version: suspended.version } },
    );
    expect(lift.status).toBe(200);
    expect((await json<SharingDecisionOut>(lift)).inForce).toBe(true);
  });
});

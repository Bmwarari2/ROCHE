import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { addUkDays, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindStaffFileExpiry } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * The staff profile and pre-employment file through the API (workforce.md sections 2a, 3 and 5;
 * WORK-002, WORK-011; plan slice 11): each route's permission, never one's own file, the file
 * state worked out today, stale versions refused, HR-only documents added, opened and audited
 * only by holders of workforce.hr_document.read and never served by the general routes, the DBS
 * risk assessment, the worker's own file, and the expiry reminders raised once each.
 */

let h: Harness;
const as = (
  who: string,
  path: string,
  init: { method?: string; body?: unknown; raw?: { bytes: Uint8Array; contentType: string } } = {},
) => h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const URL = "/v1/workforce/staff-files";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const today = () => ukIsoDate(new Date());
const inDays = (days: number) => ukIsoDate(addUkDays(new Date(), days));

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } finally {
    client.release();
  }
}

interface ItemView {
  kind: string;
  status: string;
  required: boolean;
  id: string | null;
  version: number | null;
  expiresOn: string | null;
  notes: { code: string }[];
  verifiedBy: { id: string } | null;
}
interface FileBody {
  id: string;
  version: number;
  complete: boolean;
  outstanding: string[];
  items: ItemView[];
  documents: { id: string; itemKind: string }[] | null;
}
const item = (file: FileBody, kind: string) => {
  const found = file.items.find((i) => i.kind === kind);
  if (!found) throw new Error(`no ${kind}`);
  return found;
};

const profile = {
  tenantUserId: DEMO.users.carer.id,
  locationId: DEMO.locationId,
  jobTitle: "Care worker",
  pathwayCategory: null,
  registrationBody: null,
  previousCareWork: false,
  dateOfBirth: null,
  startsOn: "2026-09-01",
  leftOn: null,
};
let carerFile: FileBody;

const record = (who: string, kind: string, body: Record<string, unknown>) =>
  as(who, `${URL}/${carerFile.id}/items/${kind}`, { method: "PUT", body });

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("staff files (workforce.md section 5)", () => {
  it("creates a file for someone else, once, and never one's own", async () => {
    const own = await as("manager", URL, {
      method: "POST",
      body: { ...profile, tenantUserId: DEMO.users.manager.id },
    });
    expect(own.status).toBe(403);
    expect(((await own.json()) as { code: string }).code).toBe("own_staff_file");
    expect((await as("carer", URL, { method: "POST", body: profile })).status).toBe(403);

    const created = await as("manager", URL, { method: "POST", body: profile });
    expect(created.status).toBe(201);
    carerFile = (await created.json()) as FileBody;
    expect(carerFile.complete).toBe(false);
    expect(carerFile.outstanding).toContain("dbs_certificate");
    expect(item(carerFile, "professional_registration").status).toBe("not_required");

    expect((await as("manager", URL, { method: "POST", body: profile })).status).toBe(409);
    const audited = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM audit_event WHERE action = 'workforce.staff_file.created' AND outcome = 'denied'",
    );
    expect(Number(audited[0]?.n)).toBeGreaterThanOrEqual(1);
  });

  it("lists files for holders of read only", async () => {
    const list = await as("manager", URL);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: { id: string; complete: boolean }[] };
    expect(body.items.map((i) => i.id)).toContain(carerFile.id);
    expect((await as("carer", URL)).status).toBe(403);
    expect((await as("nurse", `${URL}/${carerFile.id}`)).status).toBe(403);
  });

  it("records a check, verified in the caller's name, and works out its status today", async () => {
    const saved = await record("manager", "identity_with_photo", {
      detail: { kind: "identity_with_photo", document: "passport" },
      verifiedOn: today(),
    });
    expect(saved.status).toBe(200);
    const file = (await saved.json()) as FileBody;
    const identity = item(file, "identity_with_photo");
    expect(identity.status).toBe("satisfied");
    expect(identity.verifiedBy?.id).toBe(DEMO.users.manager.id);
    expect(file.outstanding).not.toContain("identity_with_photo");
  });

  it("verifies changed details again in the name of whoever changed them", async () => {
    const before = item(
      (await (await as("manager", `${URL}/${carerFile.id}`)).json()) as FileBody,
      "identity_with_photo",
    );
    const changed = await record("owner", "identity_with_photo", {
      expectedVersion: before.version,
      detail: { kind: "identity_with_photo", document: "photocard_driving_licence" },
      verifiedOn: today(),
    });
    expect(changed.status).toBe(200);
    expect(item((await changed.json()) as FileBody, "identity_with_photo").verifiedBy?.id).toBe(
      DEMO.users.owner.id,
    );
  });

  it("needs MFA for the staff file, as for care records", async () => {
    // The nurse has not enrolled a second factor; a grant of read would still need one.
    const { requiresMfa } = await import("@harbour/domain");
    expect(requiresMfa("workforce.staff_file.read")).toBe(true);
    expect(requiresMfa("workforce.hr_document.read")).toBe(true);
    expect(requiresMfa("workforce.self.read")).toBe(false);
  });

  it("refuses a stale version, a mismatched kind and a verification in the future", async () => {
    const current = item(
      (await (await as("manager", `${URL}/${carerFile.id}`)).json()) as FileBody,
      "identity_with_photo",
    );
    const stale = await record("manager", "identity_with_photo", {
      expectedVersion: (current.version ?? 1) + 5,
      detail: { kind: "identity_with_photo", document: "passport" },
      verifiedOn: today(),
    });
    expect(stale.status).toBe(409);
    const missing = await record("manager", "identity_with_photo", {
      detail: { kind: "identity_with_photo", document: "passport" },
      verifiedOn: today(),
    });
    expect(missing.status).toBe(409);
    const mismatch = await record("manager", "references", {
      detail: { kind: "identity_with_photo", document: "passport" },
      verifiedOn: today(),
    });
    expect(mismatch.status).toBe(422);
    const future = await record("manager", "references", {
      detail: { kind: "references", received: 2 },
      verifiedOn: inDays(2),
    });
    expect(future.status).toBe(422);
  });

  it("shows a time-limited right to work as due soon, with its expiry", async () => {
    const saved = await record("manager", "right_to_work", {
      detail: {
        kind: "right_to_work",
        checks: [
          {
            checkedOn: "2026-08-20",
            method: "online_share_code",
            permission: "time_limited",
            expiresOn: inDays(10),
          },
        ],
      },
      verifiedOn: today(),
    });
    const rtw = item((await saved.json()) as FileBody, "right_to_work");
    expect(rtw).toMatchObject({ status: "due_soon", expiresOn: inDays(10) });
  });

  it("keeps a worker without a DBS certificate supervised only until the certificate is seen", async () => {
    const saved = await record("manager", "dbs_certificate", {
      detail: {
        kind: "dbs_certificate",
        certificate: null,
        updateService: null,
        barredListClearOn: "2026-08-10",
      },
      verifiedOn: today(),
    });
    const dbs = item((await saved.json()) as FileBody, "dbs_certificate");
    expect(dbs.notes.map((n) => n.code)).toContain("dbs_not_clear");

    const refusedSign = await as(
      "carer",
      `${URL}/${carerFile.id}/items/dbs_certificate/risk-assessment`,
      {
        method: "POST",
        body: { expectedVersion: dbs.version, signedOn: today() },
      },
    );
    expect(refusedSign.status).toBe(403);
    const signed = await as(
      "manager",
      `${URL}/${carerFile.id}/items/dbs_certificate/risk-assessment`,
      {
        method: "POST",
        body: { expectedVersion: dbs.version, signedOn: today() },
      },
    );
    expect(signed.status).toBe(200);
    const after = item((await signed.json()) as FileBody, "dbs_certificate");
    expect(after.status).toBe("missing");
    expect(after.notes.map((n) => n.code)).toEqual(["dbs_supervised_only"]);
  });
});

describe("HR-only staff documents (workforce.md section 3)", () => {
  const upload = (who: string, kind: string) =>
    as(who, `${URL}/${carerFile.id}/items/${kind}/documents?title=Passport%20copy`, {
      method: "POST",
      raw: { bytes: PDF, contentType: "application/pdf" },
    });
  let documentId: string;

  it("are added only by holders of workforce.hr_document.read, never as a DBS copy", async () => {
    expect((await upload("manager", "identity_with_photo")).status).toBe(403);
    expect((await upload("owner", "dbs_certificate")).status).toBe(422);
    const stored = await upload("owner", "identity_with_photo");
    expect(stored.status).toBe(201);
    documentId = ((await stored.json()) as { id: string }).id;
    const generic = await as("owner", "/v1/documents?category=staff_hr_document&title=Sneaky", {
      method: "POST",
      raw: { bytes: PDF, contentType: "application/pdf" },
    });
    expect(generic.status).toBe(422);
  });

  it("keeps a right to work copy under its own retention class", async () => {
    const stored = await upload("owner", "right_to_work");
    expect(stored.status).toBe(201);
    const { id } = (await stored.json()) as { id: string };
    const [row] = await sql<{ retention_class: string }>(
      "SELECT retention_class FROM document WHERE id = $1",
      [id],
    );
    expect(row?.retention_class).toBe("right_to_work_copy");
  });

  it("are listed and opened only by holders, every open audited, and never by the general routes", async () => {
    const asOwner = (await (await as("owner", `${URL}/${carerFile.id}`)).json()) as FileBody;
    expect(asOwner.documents?.map((d) => d.id)).toContain(documentId);
    const asManager = (await (await as("manager", `${URL}/${carerFile.id}`)).json()) as FileBody;
    expect(asManager.documents).toBeNull();

    const opened = await as("owner", `${URL}/${carerFile.id}/documents/${documentId}/content`);
    expect(opened.status).toBe(200);
    expect(opened.headers.get("cache-control")).toBe("no-store");
    expect(
      (await as("manager", `${URL}/${carerFile.id}/documents/${documentId}/content`)).status,
    ).toBe(403);
    expect((await as("owner", `/v1/documents/${documentId}/content`)).status).toBe(404);
    expect((await as("owner", `/v1/documents/${documentId}`)).status).toBe(404);
    const views = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM audit_event WHERE action = 'workforce.hr_document.viewed' AND resource_id = $1",
      [documentId],
    );
    expect(Number(views[0]?.n)).toBe(1);
  });
});

describe("the worker's own file", () => {
  it("shows the worker their own file without the HR-only documents", async () => {
    const own = await as("carer", "/v1/me/staff-file");
    expect(own.status).toBe(200);
    const body = (await own.json()) as FileBody;
    expect(body.id).toBe(carerFile.id);
    expect(body.documents).toBeNull();
    expect((await as("carer", `${URL}/${carerFile.id}`)).status).toBe(403);
    expect((await as("manager", "/v1/me/staff-file")).status).toBe(404);
  });
});

describe("expiry reminders through the task engine (workforce.md rule 1)", () => {
  const deps = () => ({
    workerPool: h.db.pool("harbour_worker"),
    appDb: createDatabase(h.db.pool("harbour_app")),
    logger: createLogger("silent"),
  });
  const reminders = () =>
    sql<{ status: string; details: { reminderDays: number; reminderDueOn: string } }>(
      "SELECT status, details FROM task WHERE kind = 'workforce.compliance_expiry' ORDER BY created_at",
    );

  it("raises the right to work's reminder once, generic and assigned to HR", async () => {
    expect(await remindStaffFileExpiry(deps())).toBe(1);
    expect(await remindStaffFileExpiry(deps())).toBe(0);
    const [task] = await sql<{
      title: string;
      assignee_role_key: string;
      required_permission: string;
    }>(
      "SELECT title, assignee_role_key, required_permission FROM task WHERE kind = 'workforce.compliance_expiry'",
    );
    expect(task).toEqual({
      title: "Renew a staff check before it expires",
      assignee_role_key: "hr",
      required_permission: "workforce.staff_file.manage",
    });
    const [raised] = await reminders();
    expect(raised?.details.reminderDueOn).toBe(inDays(10));
  });

  it("ends the open reminder when the check is recorded again with a new date", async () => {
    const file = (await (await as("manager", `${URL}/${carerFile.id}`)).json()) as FileBody;
    const rtw = item(file, "right_to_work");
    const saved = await record("manager", "right_to_work", {
      expectedVersion: rtw.version,
      detail: {
        kind: "right_to_work",
        checks: [
          {
            checkedOn: today(),
            method: "online_share_code",
            permission: "time_limited",
            expiresOn: inDays(800),
          },
        ],
      },
      verifiedOn: today(),
    });
    expect(saved.status).toBe(200);
    expect((await reminders()).map((r) => r.status)).toEqual(["cancelled"]);
    expect(await remindStaffFileExpiry(deps())).toBe(0);
  });
});

describe("the staff picker for HR forms (slice 56)", () => {
  it("names staff for holders of an HR manage permission only, never with an email", async () => {
    expect((await as("carer", "/v1/workforce/staff-members")).status).toBe(403);
    const listed = await as("manager", "/v1/workforce/staff-members");
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as { items: Record<string, unknown>[] };
    expect(items.map((i) => i.id)).toContain(DEMO.users.carer.id);
    expect(JSON.stringify(items)).not.toContain("@");
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(["displayName", "id", "jobTitle"]);
  });

  it("leaves out anyone whose staff role is not in force, and portal-only members (review M1)", async () => {
    const make = async (name: string, status: string, roleKey: string, extra = "") => {
      const [m] = await sql<{ id: string }>(
        `INSERT INTO tenant_user (display_name, email, status) VALUES ($1, $2, $3::tenant_user_status) RETURNING id`,
        [name, `${name.toLowerCase().replace(/\W+/g, ".")}@example.invalid`, status],
      );
      const id = m?.id as string;
      await sql(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id ${extra ? ", valid_from, valid_to" : ""})
         SELECT $1, id, $2 ${extra} FROM role WHERE key = $3`,
        [id, DEMO.locationId, roleKey],
      );
      return id;
    };
    const expired = await make(
      "Eve Expired",
      "active",
      "agency_worker",
      ", now() - interval '2 days', now() - interval '1 day'",
    );
    const future = await make(
      "Fay Future",
      "active",
      "care_worker",
      ", now() + interval '2 days', NULL",
    );
    const suspended = await make("Sam Suspended", "suspended", "care_worker");
    const family = await make("Fred Family", "active", "family_representative");
    const current = await make("Cara Current", "invited", "care_worker");
    const listed = await as("manager", "/v1/workforce/staff-members");
    const ids = ((await listed.json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(ids).toContain(current);
    for (const id of [expired, future, suspended, family]) expect(ids).not.toContain(id);
    // The create routes refuse someone who is not current staff.
    const refused = await as("manager", URL, {
      method: "POST",
      body: { ...profile, tenantUserId: expired },
    });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { code: string }).code).toBe("not_current_staff");
  });
});

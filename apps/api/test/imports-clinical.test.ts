import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Importing medicines, care plans and staff files over HTTP (platform.md rules 27 to 31; slice 51;
 * hazards HZ-130, HZ-005, HZ-024, HZ-124): each type uploaded, dry run with every row's outcome,
 * committed with step-up and undone; rows matched by identifier only; an imported medicine held
 * off the MAR until a second check; drafts never published; checks never verified; nothing the
 * file held echoed in an audit event.
 */

let h: Harness;
type Json = Record<string, unknown>;
const send = (path: string, method: string, body?: unknown, who = "owner") =>
  h.request(path, { method, body, token: h.tokens[who], tenant: DEMO.tenantId });
const json = async (res: Response) => (await res.json()) as Json;

async function ownerSql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
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

let seed = 0;
function nextNhs(): string {
  for (;;) {
    seed += 1;
    const body = `999${String(8100000 + seed).slice(-6)}`;
    const sum = [...body].reduce((acc, d, i) => acc + Number(d) * (10 - i), 0);
    const check = 11 - (sum % 11);
    if (check === 10) continue;
    return `${body}${check === 11 ? 0 : check}`;
  }
}

async function newPerson(nhs: string): Promise<string> {
  const rows = await ownerSql<{ id: string }>(
    `INSERT INTO person (location_id, status, nhs_number, given_name, family_name, date_of_birth)
     VALUES ($1, 'active', $2, 'Ida', 'Example', '1940-02-01') RETURNING id`,
    [DEMO.locationId, nhs],
  );
  return rows[0]?.id ?? "";
}

/** Uploads, then dry-runs: the batch id and the report. */
async function staged(recordType: string, csv: string, who = "owner") {
  const up = await send(
    "/v1/imports",
    "POST",
    { recordType, locationId: DEMO.locationId, csv },
    who,
  );
  expect(up.status, JSON.stringify(await up.clone().json())).toBe(201);
  const id = ((await up.json()) as { id: string }).id;
  const dry = await send(`/v1/imports/${id}/dry-run`, "POST", undefined, who);
  expect(dry.status).toBe(200);
  return { id, report: await json(dry) };
}
const commit = (id: string) =>
  send(`/v1/imports/${id}/commit`, "POST", { acknowledgedWarnings: [] });
const undo = (id: string) => send(`/v1/imports/${id}/undo`, "POST");

const VMP = "90000011000001104";
const MED_HEADER =
  "person_nhs_number,vmp_id,route_code,directions,dose_quantity,dose_unit_code,times,indication,prescriber,starts_on,source_kind,source_reference";
const medLine = (nhs: string, over: Partial<Record<string, string>> = {}) => {
  const v = {
    vmp_id: VMP,
    route_code: "26643006",
    directions: "regular",
    dose_quantity: "1",
    dose_unit_code: "428673006",
    times: "08:00 20:00",
    indication: "",
    ...over,
  };
  return `${nhs},${v.vmp_id},${v.route_code},${v.directions},${v.dose_quantity},${v.dose_unit_code},${v.times},${v.indication},Dr Example,01/11/2026,pharmacy_mar,Pharmacy MAR October`;
};

beforeAll(async () => {
  h = await createHarness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-005 importing medicines (rule 28)", () => {
  let personId = "";
  let nhs = "";
  let batchId = "";

  it("refuses a member without the medicines permission", async () => {
    const res = await send(
      "/v1/imports",
      "POST",
      {
        recordType: "medicines",
        locationId: DEMO.locationId,
        csv: `${MED_HEADER}\n${medLine(nextNhs())}`,
      },
      "carer",
    );
    expect(res.status).toBe(403);
  });

  it("dry runs every row: unknown people, unknown dm+d codes and a name column refused", async () => {
    nhs = nextNhs();
    personId = await newPerson(nhs);
    const unknownPerson = nextNhs();
    const named = await send("/v1/imports", "POST", {
      recordType: "medicines",
      locationId: DEMO.locationId,
      csv: `${MED_HEADER},medicine_name\n${medLine(nhs)},Paracetamol`,
    });
    // A column Harbour does not import refuses the upload: a name never becomes a medicine.
    expect(named.status).toBe(422);
    const { report } = await staged(
      "medicines",
      [
        MED_HEADER,
        medLine(nhs),
        medLine(unknownPerson),
        medLine(nhs, { vmp_id: "90000021000001108" }),
      ].join("\n"),
    );
    expect(report).toMatchObject({
      recordType: "medicines",
      mayCommit: false,
      createsCount: 0,
      rowOutcomes: [
        { row: 1, outcome: "creates" },
        { row: 2, outcome: "refused" },
        { row: 3, outcome: "refused" },
      ],
    });
    const codes = (report.errors as { row: number; code: string }[]).map(
      (e) => `${e.row}:${e.code}`,
    );
    expect(codes).toEqual(expect.arrayContaining(["2:person_not_found"]));
    expect(codes.some((c) => c.startsWith("3:"))).toBe(true);
    expect(JSON.stringify(report)).not.toContain(unknownPerson);
  });

  it("commits medicines not yet checked and held off the MAR until a second check, whatever the policy", async () => {
    const { id, report } = await staged("medicines", `${MED_HEADER}\n${medLine(nhs)}`);
    expect(report, JSON.stringify(report.errors)).toMatchObject({
      mayCommit: true,
      createsCount: 1,
    });
    expect((report.whatHappens as string[]).join(" ")).toContain("Imported, not yet checked");
    const done = await commit(id);
    expect(done.status, JSON.stringify(await done.clone().json())).toBe(200);
    expect(await json(done)).toMatchObject({ records: 1, replayed: false, undoAvailable: true });
    batchId = id;
    const meds = await json(await send(`/v1/people/${personId}/medicines`, "GET"));
    const entry = (meds.entries as { product: { name: string }; status: Json }[])[0];
    expect(entry?.product.name).toBe("Paracetamol 500mg tablets");
    expect(entry?.status).toMatchObject({ words: "Imported, not yet checked", mayGive: false });
    const rows = await ownerSql<{ origin: string; state: string; import_batch_id: string }>(
      "SELECT origin, state, import_batch_id FROM medication WHERE person_id = $1",
      [personId],
    );
    expect(rows).toEqual([{ origin: "import", state: "not_yet_checked", import_batch_id: id }]);
    const audit = await ownerSql<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_event WHERE action = 'medicines.entry.imported' AND scope ->> 'importBatchId' = $1",
      [id],
    );
    expect(audit[0]?.n).toBe(1);
  });

  it("refuses a second import of the same medicine for the same person (one entry per product)", async () => {
    const { report } = await staged("medicines", `${MED_HEADER}\n${medLine(nhs)}`);
    expect(report).toMatchObject({ mayCommit: false });
    expect((report.errors as { code: string }[])[0]?.code).toBe("medicine_refused");
  });

  it("undoes by withdrawing the medicines, never deleting them", async () => {
    const res = await undo(batchId);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await json(res)).toMatchObject({ records: 1 });
    const rows = await ownerSql<{ state: string }>(
      "SELECT state FROM medication WHERE person_id = $1",
      [personId],
    );
    expect(rows).toEqual([{ state: "withdrawn" }]);
    expect((await undo(batchId)).status).toBe(409);
  });
});

describe("hazard HZ-024 importing care plans as drafts (rule 29)", () => {
  const HEADER = "person_nhs_number,domain,need,outcome";
  it("creates one draft per person with a section per row, never published, and undoes it", async () => {
    const nhs = nextNhs();
    const personId = await newPerson(nhs);
    const { id, report } = await staged(
      "care_plans",
      [
        HEADER,
        `${nhs},mobility,Needs one carer to walk.,Walks safely to meals.`,
        `${nhs},nutrition_and_hydration,Needs reminding to drink.,Drinks enough each day.`,
        `${nextNhs()},mobility,Needs help.,Walks safely.`,
      ].join("\n"),
    );
    expect(report).toMatchObject({
      mayCommit: false,
      rowOutcomes: [
        { row: 1, outcome: "creates" },
        { row: 2, outcome: "creates" },
        { row: 3, outcome: "refused" },
      ],
    });
    const good = await staged(
      "care_plans",
      [
        HEADER,
        `${nhs},mobility,Needs one carer to walk.,Walks safely to meals.`,
        `${nhs},nutrition_and_hydration,Needs reminding to drink.,Drinks enough each day.`,
      ].join("\n"),
    );
    expect(good.report).toMatchObject({ mayCommit: true, createsCount: 1 });
    expect((await commit(good.id)).status).toBe(200);
    const plans = await ownerSql<{ status: string; sections: number }>(
      `SELECT p.status, (SELECT count(*)::int FROM care_plan_section s WHERE s.plan_id = p.id) AS sections
         FROM care_plan p WHERE p.person_id = $1`,
      [personId],
    );
    expect(plans).toEqual([{ status: "draft", sections: 2 }]);
    // A second draft for the same person is refused.
    const again = await staged(
      "care_plans",
      `${HEADER}\n${nhs},mobility,Needs help.,Walks safely.`,
    );
    expect((again.report.errors as { code: string }[])[0]?.code).toBe("care_plan_draft_exists");
    const undone = await undo(good.id);
    expect(undone.status, JSON.stringify(await undone.clone().json())).toBe(200);
    expect(await ownerSql("SELECT id FROM care_plan WHERE person_id = $1", [personId])).toEqual([]);
    expect(id).not.toBe(good.id);
  });
});

describe("hazard HZ-124 importing staff file checks, never verified (rule 30)", () => {
  const HEADER = "member_email,kind,references_received";
  it("matches the staff file by work email, adds unverified checks, refuses repeats, and undoes", async () => {
    await ownerSql(
      `INSERT INTO staff_profile (tenant_user_id, location_id, job_title)
       VALUES ($1, $2, 'Care worker') ON CONFLICT DO NOTHING`,
      [DEMO.users.carer.id, DEMO.locationId],
    );
    const { report } = await staged(
      "staff_files",
      [
        HEADER,
        `${DEMO.users.carer.email.toUpperCase()},references,2`,
        "nobody@example.invalid,references,1",
      ].join("\n"),
    );
    expect(report).toMatchObject({
      rowOutcomes: [
        { row: 1, outcome: "creates" },
        { row: 2, outcome: "refused" },
      ],
    });
    expect((report.errors as { code: string }[])[0]?.code).toBe("staff_file_not_found");
    const ok = await staged("staff_files", `${HEADER}\n${DEMO.users.carer.email},references,2`);
    expect((await commit(ok.id)).status).toBe(200);
    const items = await ownerSql<{ verified_by: string | null; detail: Json }>(
      `SELECT i.verified_by, i.detail FROM compliance_item i
         JOIN staff_profile p ON p.id = i.staff_profile_id WHERE p.tenant_user_id = $1`,
      [DEMO.users.carer.id],
    );
    expect(items).toEqual([{ verified_by: null, detail: { kind: "references", received: 2 } }]);
    const repeat = await staged("staff_files", `${HEADER}\n${DEMO.users.carer.email},references,3`);
    expect((repeat.report.errors as { code: string }[])[0]?.code).toBe("check_already_recorded");
    expect((await undo(ok.id)).status).toBe(200);
    // The import never echoes the file's values in its audit trail.
    const audit = await ownerSql<{ scope: Json }>(
      "SELECT scope FROM audit_event WHERE resource_id = $1",
      [ok.id],
    );
    expect(JSON.stringify(audit)).not.toContain(DEMO.users.carer.email);
  });
});

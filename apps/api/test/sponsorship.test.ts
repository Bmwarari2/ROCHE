import { DEMO } from "@harbour/db/seed";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Sponsored workers, the staff privacy notice, staff image consent and LDSS claims through the
 * API (workforce.md section 12; slice 35; WORK-003, WORK-007, WORK-011): each route's permission,
 * never one's own sponsor record, the clocks worked out from the rate table, stale versions
 * refused, the member's own acknowledgement and consent, LDSS transitions, audit events with ids
 * only, and a staff DSAR finding the sponsor record. Invented people only.
 */

let h: Harness;
const send = (who: string, path: string, method = "GET", body?: unknown) =>
  h.request(path, {
    method,
    ...(body !== undefined ? { body } : {}),
    token: h.tokens[who],
    tenant: DEMO.tenantId,
  });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;
const today = () => ukIsoDate(new Date());

async function owner<T = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as T[];
  } finally {
    client.release();
  }
}

interface Worker {
  id: string;
  version: number;
  visa: string;
  salary: { passes: boolean; meetsYearly: boolean };
  appendixDGaps: string[];
  absenceToReport: { happenedOn: string; dueOn: string } | null;
  reports: { id: string; version: number; kind: string; state: string; dueOn: string }[];
}

const URL = "/v1/workforce/sponsored-workers";
const record = {
  tenantUserId: DEMO.users.carer.id,
  cosReference: "C2X0000001",
  cosAssignedOn: "2026-01-10",
  socCode: "6145",
  route: "health_and_care_worker",
  visaExpiresOn: "2031-01-10",
  contractedWeeklyHours: 37.5,
  guaranteedYearlyPay: 1,
  englishEvidence: "secure_english_language_test",
  switchingEvidenceOn: null,
  appendixDHeld: ["certificate_of_sponsorship", "right_to_work_check"],
};
let worker: Worker;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("WORK-003 sponsored workers", () => {
  it("are recorded by sponsor managers only, and never for oneself", async () => {
    expect((await send("manager", URL, "POST", record)).status).toBe(403);
    expect((await send("carer", URL, "POST", record)).status).toBe(403);
    const own = await send("owner", URL, "POST", { ...record, tenantUserId: DEMO.users.owner.id });
    expect(own.status).toBe(403);
    expect(await codeOf(own)).toBe("own_sponsor_record");

    const created = await send("owner", URL, "POST", record);
    expect(created.status).toBe(201);
    worker = (await created.json()) as Worker;
    expect(worker.visa).toBe("valid");
    // Pay of 1 pound a year is under any floor in the rate table.
    expect(worker.salary.passes).toBe(false);
    expect(worker.appendixDGaps).toContain("passport_or_travel_document");
    expect(worker.appendixDGaps).not.toContain("right_to_work_check");
    expect((await send("owner", URL, "POST", record)).status).toBe(409);
  });

  it("are read with workforce.immigration.read only, never by the worker or a manager", async () => {
    const list = await send("owner", URL);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      worker.id,
    );
    expect((await send("manager", URL)).status).toBe(403);
    expect((await send("carer", URL)).status).toBe(403);
  });

  it("change with the version they were read at", async () => {
    const body = { ...record, expectedVersion: worker.version, endedOn: null };
    delete (body as { tenantUserId?: string }).tenantUserId;
    const changed = await send("owner", `${URL}/${worker.id}`, "PUT", {
      ...body,
      guaranteedYearlyPay: 999_999,
      visaExpiresOn: today(),
    });
    expect(changed.status).toBe(200);
    const after = (await changed.json()) as Worker;
    expect(after.salary.meetsYearly).toBe(true);
    expect(after.visa).toBe("due_soon");
    expect((await send("owner", `${URL}/${worker.id}`, "PUT", body)).status).toBe(409);
    worker = after;
  });

  it("flag unauthorised absence past the limit and clock the report", async () => {
    const r = await send("owner", `${URL}/${worker.id}/absences`, "POST", {
      fromOn: "2026-06-01",
      toOn: "2026-06-30",
      authorised: false,
    });
    expect(r.status).toBe(201);
    const flagged = (await r.json()) as Worker;
    expect(flagged.absenceToReport).not.toBeNull();

    const reported = await send("owner", `${URL}/${worker.id}/reports`, "POST", {
      kind: "unauthorised_absence",
      happenedOn: flagged.absenceToReport?.happenedOn,
    });
    expect(reported.status).toBe(201);
    const withReport = (await reported.json()) as Worker;
    expect(withReport.absenceToReport).toBeNull();
    const report = withReport.reports[0];
    expect(report?.state).toBe("overdue");

    const marked = await send(
      "owner",
      `/v1/workforce/sponsor-reports/${report?.id}/reported`,
      "POST",
      {
        expectedVersion: report?.version,
        reportedOn: today(),
        smsReference: "SMS-0001",
      },
    );
    expect(marked.status).toBe(200);
    expect(((await marked.json()) as Worker).reports[0]?.state).toBe("reported_late");
    expect(
      (
        await send("manager", `/v1/workforce/sponsor-reports/${report?.id}/reported`, "POST", {
          expectedVersion: 2,
          reportedOn: today(),
          smsReference: "SMS-0002",
        })
      ).status,
    ).toBe(403);
  });

  it("are audited with ids and codes only", async () => {
    const rows = await owner<{ action: string; scope: string }>(
      "SELECT action, scope::text AS scope FROM audit_event WHERE action LIKE 'workforce.sponsor%'",
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        "workforce.sponsored_worker.created",
        "workforce.sponsored_worker.updated",
        "workforce.sponsor_absence.recorded",
        "workforce.sponsor_report.reported",
      ]),
    );
    const all = JSON.stringify(rows);
    expect(all).not.toContain("C2X0000001");
    expect(all).not.toContain("SMS-0001");
  });
});

describe("WORK-011 the staff privacy notice and image consent", () => {
  it("asks the member to acknowledge the version in force, once", async () => {
    expect(
      (await send("carer", "/v1/workforce/staff-privacy-notice", "PUT", { version: "2026-10" }))
        .status,
    ).toBe(403);
    expect(
      (await send("owner", "/v1/workforce/staff-privacy-notice", "PUT", { version: "2026-10" }))
        .status,
    ).toBe(200);
    let mine = (await (await send("carer", "/v1/me/staff-privacy")).json()) as {
      acknowledged: boolean;
      currentNoticeVersion: string;
    };
    expect(mine).toMatchObject({ acknowledged: false, currentNoticeVersion: "2026-10" });
    const stale = await send("carer", "/v1/me/staff-privacy/acknowledgements", "POST", {
      noticeVersion: "2025-01",
    });
    expect(stale.status).toBe(409);
    for (let i = 0; i < 2; i += 1) {
      const r = await send("carer", "/v1/me/staff-privacy/acknowledgements", "POST", {
        noticeVersion: "2026-10",
      });
      expect(r.status).toBe(200);
      mine = (await r.json()) as typeof mine;
    }
    expect(mine.acknowledged).toBe(true);
  });

  it("keeps the latest image decision, with no use until consent is given", async () => {
    type Privacy = { imageConsent: { purpose: string; decision: string; mayUse: boolean }[] };
    const start = (await (await send("carer", "/v1/me/staff-privacy")).json()) as Privacy;
    expect(start.imageConsent.find((i) => i.purpose === "website")).toMatchObject({
      decision: "none",
      mayUse: false,
    });
    await send("carer", "/v1/me/staff-image-consent", "POST", {
      purpose: "website",
      decision: "given",
    });
    const r = await send("carer", "/v1/me/staff-image-consent", "POST", {
      purpose: "website",
      decision: "withdrawn",
    });
    const after = (await r.json()) as Privacy;
    expect(after.imageConsent.find((i) => i.purpose === "website")).toMatchObject({
      decision: "withdrawn",
      mayUse: false,
    });
    const hr = await send("owner", `/v1/workforce/members/${DEMO.users.carer.id}/staff-privacy`);
    expect(hr.status).toBe(200);
    expect(
      (await send("carer", `/v1/workforce/members/${DEMO.users.owner.id}/staff-privacy`)).status,
    ).toBe(403);
  });
});

describe("WORK-007 LDSS claims", () => {
  it("are kept by holders of workforce.ldss.manage and move on by the rules", async () => {
    expect((await send("carer", "/v1/workforce/ldss-claims")).status).toBe(403);
    const created = await send("manager", "/v1/workforce/ldss-claims", "POST", {
      tenantUserId: DEMO.users.carer.id,
      courseTitle: "Level 2 Adult Social Care Certificate",
      completedOn: null,
      claimedAmount: null,
    });
    expect(created.status).toBe(201);
    const claim = (await created.json()) as { id: string; version: number };
    const path = `/v1/workforce/ldss-claims/${claim.id}/status`;
    const noRef = await send("manager", path, "POST", {
      expectedVersion: claim.version,
      status: "submitted",
      reference: null,
      on: today(),
      reason: null,
    });
    expect(noRef.status).toBe(422);
    expect(await codeOf(noRef)).toBe("ldss_reference_required");
    const paidFirst = await send("manager", path, "POST", {
      expectedVersion: claim.version,
      status: "paid",
      reference: null,
      on: today(),
      reason: null,
    });
    expect(await codeOf(paidFirst)).toBe("ldss_not_allowed");
    const submitted = await send("manager", path, "POST", {
      expectedVersion: claim.version,
      status: "submitted",
      reference: "LDSS-0001",
      on: today(),
      reason: null,
    });
    expect(submitted.status).toBe(200);
    expect(((await submitted.json()) as { status: string }).status).toBe("submitted");
    const list = (await (await send("manager", "/v1/workforce/ldss-claims")).json()) as {
      items: { id: string }[];
    };
    expect(list.items.map((i) => i.id)).toContain(claim.id);
  });
});

describe("staff DSARs (slice 15) find the new records", () => {
  it("collects the sponsor record and the member's own choices", async () => {
    const created = await send("quality", "/v1/dsar-cases", "POST", {
      requestKind: "access",
      subjectKind: "staff",
      subjectStaffId: DEMO.users.carer.id,
      requesterKind: "subject",
      channel: "email",
      receivedOn: today(),
      identityRequired: false,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    expect((await send("quality", `/v1/dsar-cases/${id}/collect`, "POST", {})).status).toBe(200);
    const items = (
      (await (await send("quality", `/v1/dsar-cases/${id}/items`)).json()) as {
        items: { tableName: string }[];
      }
    ).items.map((i) => i.tableName);
    expect(items).toEqual(
      expect.arrayContaining([
        "sponsored_worker",
        "staff_privacy_acknowledgement",
        "staff_image_consent",
        "ldss_claim",
      ]),
    );
  });
});

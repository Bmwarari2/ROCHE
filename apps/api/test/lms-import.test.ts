import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EICAR } from "../src/integrations/storage";
import { createHarness, type Harness } from "./support/harness";

/**
 * Learning platform imports through the API (workforce.md section 13; WORK-006, slice 78;
 * ADR-0102): a file staged and dry run, names ignored; learners linked by stable id, never by name;
 * a commit only after the latest dry run, and refused when things changed; ready rows imported as
 * new records marked with their source, nothing made in Harbour changed, no one importing their
 * own record; rows waiting for a person, skipped with a reason; a pull through the mock, refused
 * until connected; certificates stored with the malware scan. All the people here are invented.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const post = (who: string, path: string, body: unknown = {}) =>
  as(who, path, { method: "POST", body });
const CARER = DEMO.users.carer.id;
const NURSE = DEMO.users.nurse.id;
const MANAGER = DEMO.users.manager.id;
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");

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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface Detail {
  import: {
    id: string;
    version: number;
    dryRunNumber: number;
    status: string;
    dryRunCounts: Record<string, number>;
  };
  rows: {
    id: string;
    rowNumber: number;
    class: string;
    outcome: string;
    learnerId: string;
    workerId: string | null;
    trainingRecordId: string | null;
  }[];
}

const CSV = [
  "First name,Surname,Email,Learner ID,Course code,Completion date,Expiry date",
  "Ada,Example,ada@example.invalid,L-100,FIRE-01,01/10/2026,01/10/2027",
  "Ben,Example,ben@example.invalid,L-200,FIRE-01,02/10/2026,",
  "Ada,Example,ada@example.invalid,L-100,NEW-9,03/10/2026,",
  "Mo,Manager,mo@example.invalid,L-300,FIRE-01,04/10/2026,",
  "Ada,Example,ada@example.invalid,L-100,OMMT-2,05/10/2026,",
].join("\r\n");

let FILE = "";
let IMPORT = "";

beforeAll(async () => {
  h = await createHarness({ LMS_API: "mock" });
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-124 WORK-006 importing a file of completions", () => {
  it("sets up a source, its course mappings and learner links, never for oneself", async () => {
    const made = await post("manager", "/v1/workforce/lms-sources", {
      name: "Learning Hub",
      kind: "file",
    });
    expect(made.status).toBe(201);
    FILE = ((await made.json()) as { id: string }).id;
    for (const body of [
      { courseCode: "FIRE-01", topic: "fire_safety" },
      { courseCode: "OMMT-2", topic: "oliver_mcgowan", tier: 2 },
    ]) {
      expect(
        (await post("manager", `/v1/workforce/lms-sources/${FILE}/courses`, body)).status,
      ).toBe(201);
    }
    const noTier = await post("manager", `/v1/workforce/lms-sources/${FILE}/courses`, {
      courseCode: "OMMT-1",
      topic: "oliver_mcgowan",
    });
    expect(noTier.status).toBe(422);
    expect(
      (
        await post("manager", `/v1/workforce/lms-sources/${FILE}/learners`, {
          learnerId: "L-100",
          workerId: CARER,
        })
      ).status,
    ).toBe(201);
    // An email is not a learner id; nor may the manager link themselves.
    expect(
      (
        await post("manager", `/v1/workforce/lms-sources/${FILE}/learners`, {
          learnerId: "ada@example.invalid",
          workerId: NURSE,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post("manager", `/v1/workforce/lms-sources/${FILE}/learners`, {
          learnerId: "L-300",
          workerId: MANAGER,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post("owner", `/v1/workforce/lms-sources/${FILE}/learners`, {
          learnerId: "L-300",
          workerId: MANAGER,
        })
      ).status,
    ).toBe(201);
    expect((await as("carer", "/v1/workforce/lms-sources")).status).toBe(403);
  });

  it("stages a file and dry runs it, keeping no name or email", async () => {
    const staged = await post("manager", `/v1/workforce/lms-sources/${FILE}/imports`, {
      format: "csv",
      content: CSV,
    });
    expect(staged.status).toBe(201);
    const detail = (await staged.json()) as Detail;
    IMPORT = detail.import.id;
    expect(detail.import.dryRunNumber).toBe(1);
    expect(detail.rows.map((r) => r.class)).toEqual([
      "ready",
      "unmatched_learner",
      "unmapped_course",
      "own_record",
      "ready",
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/Ada|Ben|example\.invalid/);
    const stored = await sql("SELECT * FROM lms_import_row WHERE import_id = $1", [IMPORT]);
    expect(JSON.stringify(stored)).not.toMatch(/Ada|Ben|example\.invalid/);
    const bad = await post("manager", `/v1/workforce/lms-sources/${FILE}/imports`, {
      format: "csv",
      content: "Name,Course code\nAda,FIRE-01",
    });
    expect(bad.status).toBe(422);
    // Nothing is recorded by a dry run.
    expect(await sql("SELECT 1 FROM training_record WHERE source = 'lms'")).toHaveLength(0);
  });

  it("commits only after the latest dry run, and not when things changed since", async () => {
    expect(
      (await post("manager", `/v1/workforce/lms-imports/${IMPORT}/commit`, { dryRunNumber: 9 }))
        .status,
    ).toBe(409);
    // Linking a learner after the dry run changes what a commit would import: refused.
    await post("manager", `/v1/workforce/lms-sources/${FILE}/learners`, {
      learnerId: "L-200",
      workerId: NURSE,
    });
    const stale = await post("manager", `/v1/workforce/lms-imports/${IMPORT}/commit`, {
      dryRunNumber: 1,
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("dry_run_stale");
    expect(await sql("SELECT 1 FROM training_record WHERE source = 'lms'")).toHaveLength(0);
    // A Harbour record of the same completion is left alone, and the row is already recorded.
    await sql(
      `INSERT INTO training_record (worker_id, topic, completed_on, created_by)
       VALUES ($1, 'fire_safety', DATE '2026-10-02', $2)`,
      [NURSE, MANAGER],
    );
    const again = (await (
      await post("manager", `/v1/workforce/lms-imports/${IMPORT}/dry-run`)
    ).json()) as Detail;
    expect(again.import.dryRunNumber).toBe(2);
    expect(again.rows.map((r) => r.class)).toEqual([
      "ready",
      "already_recorded",
      "unmapped_course",
      "own_record",
      "ready",
    ]);
    const committed = await post("manager", `/v1/workforce/lms-imports/${IMPORT}/commit`, {
      dryRunNumber: 2,
    });
    expect(committed.status).toBe(200);
    const result = (await committed.json()) as {
      imported: number;
      message: string;
      detail: Detail;
    };
    expect(result.imported).toBe(2);
    expect(result.message).toMatch(/3 still need a person/);
    const records = await sql<{
      source: string;
      topic: string;
      tier: number | null;
      worker_id: string;
      provider: string;
    }>(
      "SELECT source, topic, tier, worker_id, provider FROM training_record WHERE source = 'lms' ORDER BY completed_on",
    );
    expect(records).toEqual([
      {
        source: "lms",
        topic: "fire_safety",
        tier: null,
        worker_id: CARER,
        provider: "Learning Hub",
      },
      {
        source: "lms",
        topic: "oliver_mcgowan",
        tier: 2,
        worker_id: CARER,
        provider: "Learning Hub",
      },
    ]);
    const harbour = await sql<{ source: string }>(
      "SELECT source FROM training_record WHERE worker_id = $1 AND topic = 'fire_safety'",
      [NURSE],
    );
    expect(harbour).toEqual([{ source: "harbour" }]);
  });

  it("leaves the importer's own row for someone else, and closes when every row is done", async () => {
    const detail = (await (
      await as("manager", `/v1/workforce/lms-imports/${IMPORT}`)
    ).json()) as Detail;
    const own = detail.rows.find((r) => r.class === "own_record");
    // The owner imports the manager's row.
    const ran = (await (
      await post("owner", `/v1/workforce/lms-imports/${IMPORT}/dry-run`)
    ).json()) as Detail;
    expect(ran.rows.find((r) => r.id === own?.id)?.class).toBe("ready");
    const byOwner = (await (
      await post("owner", `/v1/workforce/lms-imports/${IMPORT}/commit`, {
        dryRunNumber: ran.import.dryRunNumber,
      })
    ).json()) as { imported: number };
    expect(byOwner.imported).toBe(1);
    for (const row of ran.rows.filter((r) => r.outcome === "pending" && r.id !== own?.id)) {
      const skipped = await post(
        "manager",
        `/v1/workforce/lms-imports/${IMPORT}/rows/${row.id}/skip`,
        {
          reason: "Recorded in Harbour already",
        },
      );
      expect(skipped.status).toBe(200);
    }
    const done = (await (
      await as("manager", `/v1/workforce/lms-imports/${IMPORT}`)
    ).json()) as Detail;
    expect(done.import.status).toBe("closed");
    expect((await post("manager", `/v1/workforce/lms-imports/${IMPORT}/dry-run`)).status).toBe(409);
  });

  it("finds the same file already recorded when it is imported again", async () => {
    const again = (await (
      await post("manager", `/v1/workforce/lms-sources/${FILE}/imports`, {
        format: "csv",
        content: CSV,
      })
    ).json()) as Detail;
    expect(again.rows.filter((r) => r.class === "ready")).toHaveLength(0);
    expect(again.rows.filter((r) => r.class === "already_recorded").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(
      (
        await post("manager", `/v1/workforce/lms-imports/${again.import.id}/discard`, {
          version: again.import.version,
        })
      ).status,
    ).toBe(200);
  });
});

describe("WORK-006 pulling from a learning platform through the port", () => {
  it("refuses until connected, then stages, imports and stores certificates with the scan", async () => {
    const made = (await (
      await post("manager", "/v1/workforce/lms-sources", {
        name: "Platform API",
        kind: "api",
        externalOrganisationId: "lms-org-demo",
      })
    ).json()) as { id: string };
    const API = made.id;
    await post("manager", `/v1/workforce/lms-sources/${API}/courses`, {
      courseCode: "IPC-1",
      topic: "infection_prevention_and_control",
    });
    await post("manager", `/v1/workforce/lms-sources/${API}/learners`, {
      learnerId: "U-1",
      workerId: CARER,
    });
    await post("manager", `/v1/workforce/lms-sources/${API}/learners`, {
      learnerId: "U-2",
      workerId: NURSE,
    });
    const refused = await post("manager", `/v1/workforce/lms-sources/${API}/pull`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("integration_not_connected");
    // Credentials issued for another platform organisation are refused: only the one stored
    // with the credential is ever used.
    h.handle.learningPlatformSecrets.put(`lms/${DEMO.tenantId}/${API}`, {
      credential: "invented-credential",
      organisationId: "lms-org-other",
    });
    expect((await post("manager", `/v1/workforce/lms-sources/${API}/pull`)).status).toBe(409);
    h.handle.learningPlatformSecrets.put(`lms/${DEMO.tenantId}/${API}`, {
      credential: "invented-credential",
      organisationId: "lms-org-demo",
    });
    h.handle.learningPlatformMock.completions = [
      { learnerId: "U-1", courseCode: "IPC-1", completedOn: "2026-10-10", recordId: "c-1" },
      { learnerId: "U-2", courseCode: "IPC-1", completedOn: "2026-10-11", recordId: "c-2" },
    ];
    h.handle.learningPlatformMock.certificates.set("c-1", PDF);
    h.handle.learningPlatformMock.certificates.set(
      "c-2",
      new TextEncoder().encode(`%PDF-1.7\n${EICAR}\n%%EOF\n`),
    );
    const pulled = await post("manager", `/v1/workforce/lms-sources/${API}/pull`);
    expect(pulled.status).toBe(201);
    const detail = (await pulled.json()) as Detail;
    expect(detail.rows.map((r) => r.class)).toEqual(["ready", "ready"]);
    expect(h.handle.learningPlatformMock.calls[0]?.organisationId).toBe("lms-org-demo");
    const result = (await (
      await post("manager", `/v1/workforce/lms-imports/${detail.import.id}/commit`, {
        dryRunNumber: 1,
      })
    ).json()) as {
      imported: number;
      certificates: number;
      certificatesRefused: number;
      detail: Detail;
    };
    expect(result).toMatchObject({
      imported: 2,
      certificates: 1,
      certificatesRefused: 1,
      certificatesNotFetched: 0,
    });
    expect(result.detail.import.status).toBe("closed");
    const docs = await sql<{ category: string; subject_type: string }>(
      "SELECT category, subject_type FROM document WHERE category = 'training_certificate'",
    );
    expect(docs).toEqual([{ category: "training_certificate", subject_type: "training_record" }]);
    // A file cannot be uploaded to an API source, nor pulled from a file source.
    expect(
      (
        await post("manager", `/v1/workforce/lms-sources/${API}/imports`, {
          format: "csv",
          content: CSV,
        })
      ).status,
    ).toBe(422);
    expect((await post("manager", `/v1/workforce/lms-sources/${FILE}/pull`)).status).toBe(409);
  });
});

describe("WORK-006 adding a certificate to a training record", () => {
  it("stores a clean file for someone else's record, never one's own, never one that fails the scan", async () => {
    const [record] = await sql<{ id: string }>(
      "SELECT id FROM training_record WHERE worker_id = $1 AND source = 'lms' ORDER BY completed_on LIMIT 1",
      [CARER],
    );
    const path = `/v1/workforce/members/${CARER}/training-records/${record?.id}/certificate`;
    const upload = (who: string, p: string, bytes: Uint8Array) =>
      h.request(p, {
        method: "POST",
        token: h.tokens[who],
        tenant: DEMO.tenantId,
        raw: { bytes, contentType: "application/pdf" },
      });
    expect((await upload("manager", path, PDF)).status).toBe(201);
    expect(
      (await upload("manager", path, new TextEncoder().encode(`%PDF-1.7\n${EICAR}\n%%EOF\n`)))
        .status,
    ).toBe(422);
    const [mine] = await sql<{ id: string }>(
      "SELECT id FROM training_record WHERE worker_id = $1 LIMIT 1",
      [MANAGER],
    );
    expect(
      (
        await upload(
          "manager",
          `/v1/workforce/members/${MANAGER}/training-records/${mine?.id}/certificate`,
          PDF,
        )
      ).status,
    ).toBe(403);
    // The general document routes do not take training certificates.
    const general = await h.request(
      "/v1/documents?category=training_certificate&title=Certificate",
      {
        method: "POST",
        token: h.tokens.manager,
        tenant: DEMO.tenantId,
        raw: { bytes: PDF, contentType: "application/pdf" },
      },
    );
    expect(general.status).toBe(422);
  });

  it("audits with ids and counts, never a name or an email", async () => {
    const events = await sql<{ action: string; scope: unknown }>(
      "SELECT action, scope FROM audit_event WHERE action LIKE 'workforce.lms_%' OR action = 'workforce.training.imported'",
    );
    expect(events.length).toBeGreaterThan(5);
    expect(JSON.stringify(events)).not.toMatch(/Ada|Ben|example\.invalid|L-100/);
  });
});

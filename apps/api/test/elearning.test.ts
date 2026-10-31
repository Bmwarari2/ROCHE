import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signLaunchToken } from "../src/services/elearning-package";
import { createHarness, type Harness } from "./support/harness";
import { buildZip, SCORM12_MANIFEST, SCORM12_PACKAGE, TINCAN } from "./support/zip";

/**
 * E-learning through the API (workforce.md section 14; ADR-0093; slice 43; WORK-006): packages
 * added by training leads only, checked before anything is stored and kept off the general
 * document routes; attempts started and resumed by the member; the launch token serving only that
 * course's files and keeping only that attempt's statements; commits read through the allowlist;
 * a completion or pass recorded once as a training record; audit events with ids only.
 */

let h: Harness;
const send = (
  who: string,
  path: string,
  init: { method?: string; body?: unknown; raw?: { bytes: Uint8Array; contentType: string } } = {},
) => h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;
const COURSES = "/v1/workforce/elearning/courses";
const upload = (who: string, bytes: Buffer, query = "title=Fire%20safety&topic=fire_safety") =>
  send(who, `${COURSES}?${query}`, {
    method: "POST",
    raw: { bytes: new Uint8Array(bytes), contentType: "application/zip" },
  });

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

interface Launch {
  attemptId: string;
  token: string;
  launchPath: string;
  launchQuery: string;
  entry: string;
  standard: string;
}

let scormCourse = "";
let launch: Launch;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("WORK-006 packages", () => {
  it("are added by training leads only, checked first, and refused when unsafe", async () => {
    expect((await upload("carer", SCORM12_PACKAGE())).status).toBe(403);
    const unsafe = buildZip([
      { name: "imsmanifest.xml", data: SCORM12_MANIFEST },
      { name: "index.html", data: "x" },
      { name: "../../outside.html", data: "x" },
    ]);
    const refused = await upload("owner", unsafe);
    expect(refused.status).toBe(422);
    expect(await codeOf(refused)).toBe("package_refused");
    const denied = await sql<{ reason: string }>(
      "SELECT reason FROM audit_event WHERE action = 'workforce.elearning_course.added' AND outcome = 'denied'",
    );
    expect(denied.map((d) => d.reason)).toContain("package_archive_entry_name");
    expect((await upload("owner", SCORM12_PACKAGE(), "title=Fire&topic=astrology")).status).toBe(
      422,
    );

    const added = await upload("owner", SCORM12_PACKAGE());
    expect(added.status).toBe(201);
    const course = (await added.json()) as { id: string; standard: string; status: string };
    expect(course).toMatchObject({ standard: "scorm_1_2", status: "active" });
    scormCourse = course.id;
  });

  it("never go through the general document routes", async () => {
    const r = await send("owner", "/v1/documents?category=elearning_package&title=Sneaky", {
      method: "POST",
      raw: { bytes: new Uint8Array(SCORM12_PACKAGE()), contentType: "application/zip" },
    });
    expect(r.status).toBe(422);
  });
});

describe("WORK-006 attempts", () => {
  it("are started and resumed by the member, with a launch token", async () => {
    const list = await send("carer", COURSES);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      scormCourse,
    );
    const r = await send("carer", `${COURSES}/${scormCourse}/attempts`, {
      method: "POST",
      body: {},
    });
    expect(r.status).toBe(200);
    launch = (await r.json()) as Launch;
    expect(launch).toMatchObject({
      launchPath: "index.html",
      launchQuery: "lang=en",
      entry: "ab-initio",
    });
    const again = (await (
      await send("carer", `${COURSES}/${scormCourse}/attempts`, { method: "POST", body: {} })
    ).json()) as Launch;
    expect(again.attemptId).toBe(launch.attemptId);
  });

  it("serve only that course's files, of allowed types, for a valid token", async () => {
    const file = (path: string, token = launch.token) =>
      h.request(`/e/launch/${token}/files/${encodeURIComponent(path)}`);
    const page = await file("index.html");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await file("app.js")).status).toBe(200);
    for (const path of [
      "../app.js",
      "img/",
      "imsmanifest.xml.php",
      "missing.html",
      "/etc/passwd",
    ]) {
      expect((await file(path)).status, path).toBe(404);
    }
    const [payload, sig] = launch.token.split(".");
    expect((await file("index.html", `${payload}x.${sig}`)).status).toBe(404);
    // A token for another organisation's attempt, or an expired one, opens nothing.
    const forged = signLaunchToken(
      {
        attemptId: launch.attemptId,
        tenantId: "0194d000-0000-7000-8000-00000000ffff",
        workerId: DEMO.users.carer.id,
        courseId: scormCourse,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
      },
      "local-development-elearning-launch-secret-0123456789",
    );
    expect((await file("index.html", forged)).status).toBe(404);
  });

  it("save what the runtime reports, through the allowlist, and record a pass once", async () => {
    const commit = (who: string, cmi: Record<string, string>, finished = false) =>
      send(who, `/v1/workforce/elearning/attempts/${launch.attemptId}`, {
        method: "PATCH",
        body: { cmi, finished },
      });
    expect((await commit("carer", { "cmi.core.student_id": "x" })).status).toBe(422);
    expect((await commit("manager", { "cmi.core.lesson_status": "passed" })).status).toBe(404);
    const progress = await commit("carer", {
      "cmi.core.lesson_status": "incomplete",
      "cmi.core.lesson_location": "page-3",
      "cmi.suspend_data": "state",
    });
    expect(((await progress.json()) as { status: string }).status).toBe("in_progress");
    const resumed = (await (
      await send("carer", `${COURSES}/${scormCourse}/attempts`, { method: "POST", body: {} })
    ).json()) as Launch & { location: string };
    expect(resumed).toMatchObject({ entry: "resume", location: "page-3" });

    const passed = await commit(
      "carer",
      {
        "cmi.core.lesson_status": "passed",
        "cmi.core.score.raw": "85",
        "cmi.core.session_time": "00:12:30",
      },
      true,
    );
    const body = (await passed.json()) as {
      status: string;
      score: number;
      totalSeconds: number;
      trainingRecordId: string;
    };
    expect(body).toMatchObject({ status: "passed", score: 0.85, totalSeconds: 750 });
    expect(body.trainingRecordId).toBeTruthy();
    // Committed again: still one record, and the pass is kept.
    await commit("carer", { "cmi.core.lesson_status": "failed" }, true);
    const records = await sql<{ n: string; provider: string }>(
      "SELECT count(*) AS n, max(provider) AS provider FROM training_record WHERE worker_id = $1 AND topic = 'fire_safety'",
      [DEMO.users.carer.id],
    );
    expect(Number(records[0]?.n)).toBe(1);
    expect(records[0]?.provider).toBe("Harbour e-learning: Fire safety");
    const [attempt] = await sql<{ status: string }>(
      "SELECT status FROM elearning_attempt WHERE id = $1",
      [launch.attemptId],
    );
    expect(attempt?.status).toBe("passed");
    const audited = await sql<{ scope: string }>(
      "SELECT scope::text AS scope FROM audit_event WHERE action = 'workforce.elearning_attempt.completed'",
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.scope).not.toContain("85");
  });

  it("show training leads every attempt, and staff none of the list", async () => {
    expect((await send("carer", `${COURSES}/${scormCourse}/attempts`)).status).toBe(403);
    const r = await send("manager", `${COURSES}/${scormCourse}/attempts`);
    expect(((await r.json()) as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("WORK-006 xAPI courses settle from their statements", () => {
  it("keeps statements once, refuses oversized ones, and records a completion", async () => {
    const zip = buildZip([
      { name: "tincan.xml", data: TINCAN },
      { name: "story.html", data: "<!doctype html>" },
    ]);
    const added = await upload("owner", zip, "title=Dementia%20awareness&topic=dementia_awareness");
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: string };
    const start = (await (
      await send("carer", `${COURSES}/${id}/attempts`, { method: "POST", body: {} })
    ).json()) as Launch;
    const post = (body: unknown) =>
      h.request(`/e/launch/${start.token}/statements`, { method: "POST", body });
    const statementId = "0199f300-0000-7000-8000-00000000aa01";
    const statement = {
      id: statementId,
      actor: { account: { homePage: "https://harbour.example.invalid", name: start.attemptId } },
      verb: { id: "http://adlnet.gov/expapi/verbs/completed" },
      object: { id: "https://courses.example.invalid/fire" },
      result: { score: { scaled: 0.9 } },
    };
    expect((await post({ ...statement, padding: "x".repeat(17 * 1024) })).status).toBe(400);
    expect((await post({ verb: { id: "not a url" } })).status).toBe(400);
    const kept = await post(statement);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toEqual([statementId]);
    expect((await post(statement)).status).toBe(200);
    const rows = await sql<{ n: string }>(
      "SELECT count(*) AS n FROM elearning_statement WHERE attempt_id = $1",
      [start.attemptId],
    );
    expect(Number(rows[0]?.n)).toBe(1);
    const [attempt] = await sql<{ status: string; training_record_id: string | null }>(
      "SELECT status, training_record_id FROM elearning_attempt WHERE id = $1",
      [start.attemptId],
    );
    expect(attempt?.status).toBe("completed");
    expect(attempt?.training_record_id).toBeTruthy();
    // xAPI courses take no SCORM commits.
    const commit = await send("carer", `/v1/workforce/elearning/attempts/${start.attemptId}`, {
      method: "PATCH",
      body: { cmi: {}, finished: false },
    });
    expect(commit.status).toBe(422);
  });
});

describe("WORK-006 retired courses", () => {
  it("are no longer offered to staff", async () => {
    expect(
      (await send("carer", `${COURSES}/${scormCourse}/retire`, { method: "POST", body: {} }))
        .status,
    ).toBe(403);
    expect(
      (await send("owner", `${COURSES}/${scormCourse}/retire`, { method: "POST", body: {} }))
        .status,
    ).toBe(200);
    const list = (await (await send("carer", COURSES)).json()) as { items: { id: string }[] };
    expect(list.items.map((i) => i.id)).not.toContain(scormCourse);
    expect(
      (await send("carer", `${COURSES}/${scormCourse}/attempts`, { method: "POST", body: {} }))
        .status,
    ).toBe(404);
  });
});

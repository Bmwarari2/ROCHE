import {
  HANDOVER_ID_HEADER as CONTRACT_ID_HEADER,
  HANDOVER_OWNER_HEADER as CONTRACT_OWNER_HEADER,
} from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import type { Me } from "../auth/auth-client";
import type { FetchLike } from "../auth/http";
import { DEMO_TENANT_ID, demoPeople } from "../demo/demo-data";
import { t } from "../i18n/t";
import { all, openLocalDatabase } from "../test-support/local-db";
import {
  HANDOVER_ID_HEADER,
  HANDOVER_OWNER_HEADER,
  HANDOVER_PERMISSION,
  HandOverNotAllowedError,
  handOverHeldWork,
  handOverMessage,
  handOverRefusal,
} from "./handover";
import type { HeldWork } from "./held-work";

const API = "https://api.example.invalid";
const NOW = new Date("2026-10-11T07:30:00.000Z");
const DEVICE = "0199d000-0000-4000-8000-0000000000d7";
const HANDOVER = "0199d000-0000-4000-8000-0000000000e7";
const PERSON = demoPeople[0]?.id ?? "";

/** Invented staff: Sam Example wrote the entries; Mo Example manages the home. */
const sam: Me = {
  user: { id: "user-sam", name: "Sam Example" },
  tenant: { id: DEMO_TENANT_ID, name: "Example Care" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c1",
  locations: [],
  permissions: ["people.person.read", "care.note.write"],
};
const mo: Me = {
  ...sam,
  user: { id: "user-mo", name: "Mo Example" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c3",
  permissions: [...sam.permissions, HANDOVER_PERMISSION, "safety.incident.manage"],
};
const kit: Me = {
  ...sam,
  user: { id: "user-kit", name: "Kit Sample" },
  tenantUserId: "00000000-0000-4000-8000-0000000000c2",
};

const held: HeldWork = {
  tenantId: DEMO_TENANT_ID,
  tenantUserId: sam.tenantUserId,
  userId: sam.user.id,
  ownerName: "Sam Example",
  entries: 2,
  heldAt: NOW.toISOString(),
  expiresAt: "2026-10-18T07:30:00.000Z",
  lastServerTime: null,
};

const note = (id: string, body = "Settled; checked at 03:00.") => ({
  id,
  tenant_id: DEMO_TENANT_ID,
  person_id: PERSON,
  location_id: null,
  occurred_at: "2026-10-11T03:00:00.000Z",
  device_time: "2026-10-11T03:10:00.000Z",
  category: "personal_care",
  body,
  tags: "[]",
});

async function heldDatabase(entries: Array<{ id: string; table?: string; op?: string }>) {
  const sql = await openLocalDatabase();
  entries.forEach((entry, position) => {
    sql
      .prepare(
        `INSERT INTO held_entry (id, tenant_id, person_id, record_table, op, payload, position, held_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        DEMO_TENANT_ID,
        PERSON,
        entry.table ?? "care_note",
        entry.op ?? "PUT",
        JSON.stringify(note(entry.id)),
        position + 1,
        NOW.toISOString(),
      );
  });
  const db = {
    execute: async (query: string, params: unknown[] = []) =>
      sql.prepare(query).run(...(params as never[])),
    getAll: async <T>(query: string, params: unknown[] = []) => all<T>(sql, query, params),
    getOptional: async <T>(query: string, params: unknown[] = []) =>
      all<T>(sql, query, params)[0] ?? null,
  };
  const rows = (table: string) =>
    all<{ id: string; code?: string; server_copy?: string | null }>(
      sql,
      `SELECT * FROM ${table} ORDER BY id`,
      [],
    );
  return { db, rows };
}

function fakeFetch(answers: Array<number | Error | Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new Error("No more fake responses");
    if (next instanceof Error) throw next;
    if (next instanceof Response) return next;
    return new Response(
      next < 300 ? '{"id":"x"}' : '{"code":"invalid","detail":"The person had left."}',
      {
        status: next,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return { fetch, calls };
}

const deps = (
  db: Parameters<typeof handOverHeldWork>[0]["db"],
  fetch: FetchLike,
  hold = held,
  sendReport: () => Promise<boolean> = async () => true,
) => ({
  held: hold,
  db,
  api: { apiUrl: API, fetch, token: "tok-mo", tenantId: DEMO_TENANT_ID, deviceId: DEVICE },
  handoverId: HANDOVER,
  now: () => NOW,
  sendReport,
});

const problem = (status: number, code: string, detail: string) =>
  new Response(JSON.stringify({ code, detail }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });

const E1 = "0199d000-0000-7000-8000-0000000000f1";
const E2 = "0199d000-0000-7000-8000-0000000000f2";

describe("hazard HZ-040 who may hand over held entries (care.md section 6, Device integrity part 6)", () => {
  it.each([
    ["a manager with the hand-over permission", held, mo, null],
    [
      "a manager of another organisation",
      held,
      { ...mo, tenant: { ...mo.tenant, id: "00000000-0000-4000-8000-0000000000aa" } },
      "not_allowed",
    ],
    ["a care worker", held, kit, "not_allowed"],
    ["the owner, who signs in to resume instead", held, sam, "not_allowed"],
    ["the owner, on a device a manager revoked", { ...held, revoked: true }, sam, null],
    ["anyone, when the owner is unknown", { ...held, tenantUserId: null }, mo, "unknown_owner"],
    ["anyone, for entries a failed deletion left", { ...held, uploadBlocked: true }, mo, "blocked"],
  ] as const)("%s", (_case, hold, signer, refusal) => {
    expect(handOverRefusal(hold, signer)).toBe(refusal);
  });

  it("names the owner and the hand-over with the API's own headers", () => {
    expect([HANDOVER_OWNER_HEADER, HANDOVER_ID_HEADER]).toEqual([
      CONTRACT_OWNER_HEADER,
      CONTRACT_ID_HEADER,
    ]);
  });

  it("says why it is refused, in words", () => {
    expect(new HandOverNotAllowedError("unknown_owner").message).toBe(
      t("mobile.held.handOverUnknownOwner"),
    );
    expect(new HandOverNotAllowedError("not_allowed").message).toBe(
      t("mobile.held.handOverNotAllowed"),
    );
  });
});

describe("hazard HZ-040 hazard HZ-006 handing over held entries (Device integrity part 6)", () => {
  it("sends each held entry in its owner's name, in order, and nothing is left on the device", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }, { id: E2 }]);
    const { fetch, calls } = fakeFetch([201, 201]);
    const result = await handOverHeldWork(deps(db, fetch));
    expect(result).toEqual({ sent: 2, parked: 0, copied: 0, remaining: 0, stopped: null });
    expect(rows("held_entry")).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/v1/people/${PERSON}/notes`,
      `${API}/v1/people/${PERSON}/notes`,
    ]);
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok-mo");
    expect(headers.get(HANDOVER_OWNER_HEADER)).toBe(sam.tenantUserId);
    expect(headers.get(HANDOVER_ID_HEADER)).toBe(HANDOVER);
    expect(headers.get("x-harbour-device")).toBe(DEVICE);
    expect(headers.get("idempotency-key")).toBe(E1);
    expect(handOverMessage(result)).toBe(
      "2 entries were sent to Harbour. Nothing is left on this device.",
    );
  });

  it("hazard HZ-006 moves an entry the API refuses to needs attention, sends its copy in the owner's name, and keeps the database while it waits (#25 review round 2, H2)", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }, { id: E2 }]);
    const { fetch, calls } = fakeFetch([422, 201, 200]);
    const result = await handOverHeldWork(deps(db, fetch));
    // The refused entry is still on the device although the server has its copy: no screen reads
    // the copy yet, so the device is not wiped (H-134).
    expect(result).toMatchObject({ sent: 1, parked: 1, copied: 1, remaining: 1, stopped: null });
    expect(rows("upload_issue")).toEqual([
      expect.objectContaining({ id: E1, code: "invalid", server_copy: "copied" }),
    ]);
    const copy = calls[2];
    expect(copy?.url).toBe(`${API}/v1/sync/refused-entries`);
    expect(new Headers(copy?.init?.headers).get(HANDOVER_OWNER_HEADER)).toBe(sam.tenantUserId);
    expect(JSON.parse(String(copy?.init?.body))).toMatchObject({ entryId: E1, code: "invalid" });
    expect(handOverMessage(result)).toContain("wait under Not saved: needs attention");
  });

  it("hazard HZ-006 stops and keeps the entry held when the server cannot find the person in the sender's scope, never parking it (#25 review round 2, H2)", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }, { id: E2 }]);
    const { fetch, calls } = fakeFetch([problem(404, "not_found", "We could not find that.")]);
    const result = await handOverHeldWork(deps(db, fetch));
    expect(result).toMatchObject({ sent: 0, parked: 0, remaining: 2, stopped: "not_taken" });
    expect(calls).toHaveLength(1);
    expect(rows("held_entry").map((r) => r.id)).toEqual([E1, E2]);
    expect(rows("upload_issue")).toEqual([]);
  });

  it("hazard HZ-040 stops and keeps the entry held when the server will not take the hand-over, saying why (#25 review round 2, H1 and H2)", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }]);
    const reason = "This entry is timed after the device was withdrawn.";
    const result = await handOverHeldWork(
      deps(db, fakeFetch([problem(422, "handover_refused", reason)]).fetch),
    );
    expect(result).toMatchObject({ sent: 0, parked: 0, remaining: 1, stopped: "not_taken" });
    expect(rows("held_entry").map((r) => r.id)).toEqual([E1]);
    expect(rows("upload_issue")).toEqual([]);
    expect(handOverMessage(result)).toContain(reason);
  });

  it("hazard HZ-040 sends the device's report from the sender's sign-in first, and sends nothing when it cannot (#25 review round 2, H1)", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }]);
    const order: string[] = [];
    const { fetch, calls } = fakeFetch([201]);
    const sent = await handOverHeldWork(
      deps(
        db,
        async (url, init) => {
          order.push("entry");
          return fetch(url, init);
        },
        held,
        async () => {
          order.push("report");
          return true;
        },
      ),
    );
    expect(order).toEqual(["report", "entry"]);
    expect(sent).toMatchObject({ sent: 1, remaining: 0 });
    expect(calls).toHaveLength(1);
    const again = await heldDatabase([{ id: E2 }]);
    const offline = await handOverHeldWork(
      deps(again.db, fakeFetch([]).fetch, held, async () => false),
    );
    expect(offline).toMatchObject({ sent: 0, remaining: 1, stopped: "offline" });
    expect(again.rows("held_entry").map((r) => r.id)).toEqual([E2]);
    expect(rows("held_entry")).toEqual([]);
  });

  it("stops when the device goes offline, keeping the rest held and counted", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }, { id: E2 }]);
    const result = await handOverHeldWork(
      deps(db, fakeFetch([201, new TypeError("offline")]).fetch),
    );
    expect(result).toEqual({ sent: 1, parked: 0, copied: 0, remaining: 1, stopped: "offline" });
    expect(rows("held_entry").map((r) => r.id)).toEqual([E2]);
    expect(handOverMessage(result)).toBe(
      "1 entry was sent. 1 entry is still on this device. Entries Harbour could not save wait under Not saved: needs attention for the nurse in charge. Send the rest again when the device is online, or a manager can delete them with a reason.",
    );
  });

  it("hazard HZ-006 stops at a refusal of the sign-in, the permission or any other 403, never parking the entry (#25 review round 2, H2)", async () => {
    const { db, rows } = await heldDatabase([{ id: E1 }]);
    const result = await handOverHeldWork(deps(db, fakeFetch([403]).fetch));
    expect(result).toMatchObject({ sent: 0, parked: 0, remaining: 1, stopped: "session" });
    expect(rows("upload_issue")).toEqual([]);
  });

  it("never sends a change that is not a care entry, keeping it for review instead", async () => {
    const { db, rows } = await heldDatabase([{ id: E1, table: "person" }]);
    const { fetch, calls } = fakeFetch([]);
    const result = await handOverHeldWork(deps(db, fetch));
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ parked: 1, remaining: 1 });
    // Still on the device: the hold stays rather than the database being deleted.
    expect(rows("upload_issue")).toEqual([
      expect.objectContaining({ id: E1, code: "held_not_restored", server_copy: "not_copied" }),
    ]);
  });

  it("refuses to send entries whose owner is unknown", async () => {
    const { db } = await heldDatabase([{ id: E1 }]);
    await expect(
      handOverHeldWork(deps(db, fakeFetch([]).fetch, { ...held, tenantUserId: null })),
    ).rejects.toBeInstanceOf(HandOverNotAllowedError);
  });
});

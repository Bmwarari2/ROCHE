import { describe, expect, it } from "vitest";
import { decidableOnPhone, parseConflicts, resolveConflict, sameDose } from "./conflicts";

const conflict = (overrides: Record<string, unknown> = {}) => ({
  id: "c1",
  personId: "p1",
  entryId: "e1",
  dueAt: "2026-11-03T08:00:00.000Z",
  standing: {
    outcome: "given",
    amount: { quantity: 1, unitCode: "u" },
    givenAt: "2026-11-03T08:01:00Z",
  },
  uploaded: {
    outcome: "given",
    amount: { quantity: 1, unitCode: "u" },
    givenAt: "2026-11-03T08:03:00Z",
  },
  resolution: null,
  ...overrides,
});

describe("hazard HZ-004 the nurse in charge reviews a dose recorded on two phones (slice 70)", () => {
  it("reads the open conflicts, counting any it cannot read rather than dropping them silently", () => {
    const out = parseConflicts({ conflicts: [conflict(), { id: 3 }], truncated: false });
    expect(out.conflicts.map((c) => c.id)).toEqual(["c1"]);
    expect(out.unreadable).toBe(1);
  });

  it("says when the two records agree, and when they differ, and who recorded each", () => {
    const [same] = parseConflicts({ conflicts: [conflict()] }).conflicts;
    const [differ] = parseConflicts({
      conflicts: [conflict({ uploaded: { outcome: "refused", amount: null, givenAt: null } })],
    }).conflicts;
    expect(same && sameDose(same)).toBe(true);
    expect(differ && sameDose(differ)).toBe(false);
  });

  it("resolves through the API with the nurse's words, and passes on a refusal's detail", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ detail: "Say why." }), { status: 422 });
    }) as unknown as Parameters<typeof resolveConflict>[0]["fetch"];
    const r = await resolveConflict(
      { apiUrl: "https://api.example.invalid", fetch, token: "t", tenantId: "x", deviceId: "d" },
      "c1",
      "first_stands",
      " Same dose sent twice ",
    );
    expect(r).toEqual({ ok: false, detail: "Say why." });
    expect(calls[0]?.url).toBe(
      "https://api.example.invalid/v1/medicine-administration-conflicts/c1/resolve",
    );
    expect(calls[0]?.body).toEqual({
      outcome: "first_stands",
      correctionId: null,
      note: "Same dose sent twice",
    });
  });
});

describe("hazard HZ-116 a controlled drug's conflict is decided on the web, with step-up", () => {
  it.each([
    ["an ordinary medicine", { cd_schedule: null }, true],
    ["a controlled drug", { cd_schedule: "2" }, false],
    ["a medicine not on the phone", undefined, false],
  ] as const)("%s", (_case, medicine, decidable) => {
    expect(decidableOnPhone(medicine)).toBe(decidable);
  });
});

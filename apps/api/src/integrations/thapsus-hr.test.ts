import type { ThapsusHrPort } from "@harbour/domain";
import { connectionRefusal, outboundExtraFields } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { MockThapsusHr, THAPSUS_HR_CAPABILITIES, THAPSUS_HR_PINNED_COMMIT } from "./thapsus-hr";

/**
 * The Thapsus-HR port's contract (slice 86; ADR-0126; integrations.md section 11.10). A real
 * adapter joins the mock below and runs the same contract. Every write must be idempotent by
 * Harbour's event identifier; planned capabilities answer `planned`.
 */

const workspace = {
  slug: "example-care",
  homeRegion: "uk",
  apiBaseUrl: "https://api.uk.thapsus.example/v1",
};

function contract(name: string, make: () => ThapsusHrPort) {
  describe(`hazard HZ-133 Thapsus-HR contract: ${name}`, () => {
    it("says where it runs, and the link accepts only a UK workspace on the UK host", async () => {
      const ws = await make().workspace();
      expect(ws.ok).toBe(true);
      if (!ws.ok) return;
      expect(
        connectionRefusal({
          homeRegion: ws.value.homeRegion,
          // The URL this adapter really sends to, never what the workspace reports (rule 1).
          apiBaseUrl: make().apiBaseUrl,
          thapsusDomain: "thapsus.example",
        }),
      ).toBeNull();
    });

    it("creates a starter once per idempotency key, sending only the starter's fields", async () => {
      const port = make();
      const starter = {
        givenName: "Ada",
        familyName: "Example",
        workEmail: "ada.example@example.invalid",
        dateOfBirth: "1990-05-01",
        jobTitle: "Care worker",
        locationId: "loc-1",
        contractedHours: 37.5,
        startDate: "2026-12-01",
      };
      expect(outboundExtraFields("starter", starter)).toEqual([]);
      const first = await port.createEmployee(starter, "evt-1");
      const again = await port.createEmployee(starter, "evt-1");
      expect(first.ok && again.ok).toBe(true);
      if (first.ok && again.ok) expect(again.value.id).toBe(first.value.id);
    });

    it("sends shifts and clock events once per key", async () => {
      const port = make();
      const shift = {
        harbourRef: "s1",
        employeeId: "e1",
        locationId: "l1",
        role: "care_worker",
        startsAt: "2026-12-01T08:00:00Z",
        endsAt: "2026-12-01T16:00:00Z",
        startsAtLocal: "2026-12-01T08:00",
        endsAtLocal: "2026-12-01T16:00",
        breakMinutes: 30,
      };
      const a = await port.upsertShift(shift, "evt-2");
      const b = await port.upsertShift(shift, "evt-2");
      if (a.ok && b.ok) expect(b.value.id).toBe(a.value.id);
      const clock = await port.postClockEvent(
        {
          harbourRef: "c1",
          employeeId: "e1",
          kind: "in",
          at: "2026-12-01T08:01:00Z",
          atLocal: "2026-12-01T08:01",
          locationId: "l1",
        },
        "evt-3",
      );
      expect(clock.ok).toBe(true);
    });

    it("answers planned for what Thapsus-HR's Phase 19 has not shipped", async () => {
      const port = make();
      expect(await port.putPayUnits("pp-1", [], "evt-4")).toEqual({ ok: false, error: "planned" });
      expect(await port.rates(["e1"])).toEqual({ ok: false, error: "planned" });
      expect(await port.payPeriods()).toEqual({ ok: false, error: "planned" });
      expect(port.capabilities().partner_pay_items).toBe("planned");
    });

    it("reports its health", async () => {
      expect((await make().health()).ok).toBe(true);
    });
  });
}

contract("mock", () => new MockThapsusHr(workspace));

describe("hazard HZ-140 the mock serves Phase 19 pay only when asked, as planned (K4, K5)", () => {
  const port = () => {
    const p = new MockThapsusHr(workspace);
    p.phase19 = true;
    p.payPeriodsList.push({
      id: "pp_1",
      frequency: "weekly",
      startsOn: "2026-11-02",
      endsOn: "2026-11-08",
    });
    p.ratesList.push(
      { employeeId: "e1", hourlyPence: 1_271, effectiveFrom: "2026-04-01" },
      { employeeId: "e2", hourlyPence: 1_300, effectiveFrom: "2026-04-01" },
    );
    return p;
  };
  const unit = { employeeId: "e1", payPeriodId: "pp_1", payCode: "BASIC", units: 37.5 };

  it("says the pay capabilities are available, and reads periods and the rates asked for", async () => {
    const p = port();
    expect(p.capabilities()).toMatchObject({
      partner_pay_items: "available",
      pay_rates_read: "available",
    });
    expect(await p.payPeriods()).toMatchObject({ ok: true, value: [{ id: "pp_1" }] });
    expect(await p.rates(["e1"])).toEqual({
      ok: true,
      value: [{ employeeId: "e1", hourlyPence: 1_271, effectiveFrom: "2026-04-01" }],
    });
  });

  it("replaces a period's items with each put, and replays a key without applying it again", async () => {
    const p = port();
    expect(await p.putPayUnits("pp_1", [unit], "k1")).toEqual({ ok: true, value: { accepted: 1 } });
    expect(await p.putPayUnits("pp_1", [{ ...unit, units: 40 }], "k2")).toMatchObject({ ok: true });
    expect(p.payItems.get("pp_1")).toEqual([{ ...unit, units: 40 }]);
    expect(await p.putPayUnits("pp_1", [unit], "k1")).toMatchObject({ ok: true });
    expect(p.payItems.get("pp_1")).toEqual([{ ...unit, units: 40 }]);
  });

  it("refuses money, an unknown period and an item for another period", async () => {
    const p = port();
    expect(await p.putPayUnits("pp_1", [{ ...unit, pence: 4_000 } as never], "k3")).toEqual({
      ok: false,
      error: "refused",
    });
    expect(await p.putPayUnits("pp_9", [unit], "k4")).toEqual({ ok: false, error: "not_found" });
    expect(await p.putPayUnits("pp_1", [{ ...unit, payPeriodId: "pp_2" }], "k5")).toEqual({
      ok: false,
      error: "refused",
    });
  });
});

describe("hazard HZ-133 the mock's behaviour", () => {
  it("returns 429 with Retry-After once the minute's calls are spent", async () => {
    const port = new MockThapsusHr(workspace);
    port.callsLeft = 1;
    expect((await port.workspace()).ok).toBe(true);
    expect(await port.workspace()).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: 60,
    });
  });

  it("pages employees by cursor", async () => {
    const port = new MockThapsusHr(workspace);
    for (let i = 0; i < 150; i++) {
      port.employeesById.set(`hr-e${i}`, {
        id: `hr-e${i}`,
        employeeNumber: `E${i}`,
        workEmail: `staff${i}@example.invalid`,
        dateOfBirth: "1990-01-01",
        givenName: "Sam",
        familyName: "Example",
        leavingDate: null,
      });
    }
    const first = await port.employees(null);
    if (!first.ok) throw new Error("not ok");
    expect(first.value.items).toHaveLength(100);
    const second = await port.employees(first.value.nextCursor);
    if (!second.ok) throw new Error("not ok");
    expect([second.value.items.length, second.value.nextCursor]).toEqual([50, null]);
  });
});

describe("hazard HZ-133 the mock's guards", () => {
  it("is refused when it sends to the EU host though the workspace claims the UK one", () => {
    const port = new MockThapsusHr(workspace, "https://api.eu.thapsus.example/v1");
    expect(
      connectionRefusal({
        homeRegion: "uk",
        apiBaseUrl: port.apiBaseUrl,
        thapsusDomain: "thapsus.example",
      }),
    ).toBe("not_uk_host");
  });

  const shift = {
    harbourRef: "s9",
    employeeId: "e1",
    locationId: "l1",
    role: "care_worker",
    startsAt: "2026-12-01T08:00:00Z",
    endsAt: "2026-12-01T16:00:00Z",
    startsAtLocal: "2026-12-01T08:00",
    endsAtLocal: "2026-12-01T16:00",
    breakMinutes: 30,
  };

  it("refuses a payload outside the flow's allow-list, sending nothing", async () => {
    const port = new MockThapsusHr(workspace);
    const nested = {
      ...shift,
      role: { visit: { address: "1 Example Road" } },
    } as unknown as typeof shift;
    expect(await port.upsertShift(nested, "evt-9")).toEqual({ ok: false, error: "refused" });
    expect(
      await port.postClockEvent(
        {
          harbourRef: "c9",
          employeeId: "e1",
          kind: "break_start",
          at: "t",
          atLocal: "t",
          locationId: "l1",
        },
        "evt-10",
      ),
    ).toEqual({ ok: false, error: "refused" });
    expect(port.writes).toEqual([]);
  });

  it("answers conflict when a key comes back with a different body", async () => {
    const port = new MockThapsusHr(workspace);
    await port.upsertShift(shift, "evt-11");
    expect(await port.upsertShift({ ...shift, breakMinutes: 45 }, "evt-11")).toEqual({
      ok: false,
      error: "conflict",
    });
  });

  it("forgets a key after 24 hours, as Thapsus-HR does: a later retry would create it again", async () => {
    const port = new MockThapsusHr(workspace);
    let clock = Date.parse("2026-12-01T08:00:00Z");
    port.now = () => clock;
    const first = await port.upsertShift(shift, "evt-12");
    clock += 24 * 3_600_000;
    const later = await port.upsertShift(shift, "evt-12");
    if (!first.ok || !later.ok) throw new Error("not ok");
    // So Harbour looks up its partner reference before retrying an old event (rule 5, slice 88).
    expect(later.value.id).not.toBe(first.value.id);
  });
});

describe("hazard HZ-133 the pin (re-pin when Thapsus-HR Phase 19 ships)", () => {
  // When Phase 19 (K1 to K7) ships: pin the new commit on Thapsus-HR's main, check the mock and this
  // contract against its published OpenAPI document, and move each capability below to available.
  it("is commit d9888cef, with every Phase 19 capability still planned", () => {
    expect(THAPSUS_HR_PINNED_COMMIT).toBe("d9888cef");
    expect(
      Object.entries(THAPSUS_HR_CAPABILITIES)
        .filter(([, state]) => state === "planned")
        .map(([name]) => name)
        .sort(),
    ).toEqual([
      "partner_connections",
      "partner_events",
      "partner_managed_records",
      "partner_pay_items",
      "partner_rate_limit",
      "pay_rates_read",
    ]);
  });
});

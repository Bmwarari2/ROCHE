import type { VettingAnswer, VettingCheckKind, VettingRequestMap } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import {
  createVettingAdapter,
  KNOWN_VETTING_PROVIDERS,
  MOCK_SCENARIOS,
  MockVetting,
  strictVetting,
} from "./vetting";
import { vettingContract } from "./vetting.contract";

/**
 * The vetting adapters (ADR-0094; workforce.md section 2e): the shared contract suite run on every
 * mock scenario; the chooser off without a connection, with an unknown provider and for the mock
 * in production; answers a port does not declare refused.
 */

const REF = "0199f600-0000-7000-8000-000000000001";
const CLOCK = () => new Date("2026-10-31T10:00:00Z");
const REQUESTS: { [K in VettingCheckKind]: VettingRequestMap[K] } = {
  idsp_right_to_work: {
    reference: REF,
    name: "Ada Example",
    email: "ada.vetting@example.invalid",
    document: "british_passport",
  },
  dbs_application: {
    reference: REF,
    name: "Ada Example",
    email: "ada.vetting@example.invalid",
    level: "enhanced_adults_barred",
    workforce: "adult",
    jobTitle: "Care worker",
  },
  dbs_status_check: {
    reference: REF,
    certificateNumber: "009999999999",
    familyName: "Example",
    dateOfBirth: "1990-04-01",
  },
  nmc_register_check: { reference: REF, pin: "99A9999E" },
};

for (const kind of Object.keys(MOCK_SCENARIOS) as VettingCheckKind[]) {
  for (const scenario of MOCK_SCENARIOS[kind]) {
    describe(`the ${kind} mock, scenario ${scenario}, meets the contract`, () => {
      vettingContract({
        kind,
        request: REQUESTS[kind] as never,
        make: () => {
          const mock = new MockVetting(kind, scenario, CLOCK);
          return { adapter: mock as never, sent: () => mock.requests };
        },
      });
    });
  }
}

describe("the mock's answers", () => {
  it.each<[VettingCheckKind, string, Record<string, unknown>]>([
    [
      "idsp_right_to_work",
      "verified",
      { outcome: "identity_verified", document: "british_passport" },
    ],
    ["idsp_right_to_work", "not_verified", { outcome: "not_verified" }],
    ["dbs_application", "clear", { outcome: "certificate_issued", result: "clear" }],
    [
      "dbs_application",
      "disclosed",
      { outcome: "certificate_issued", result: "information_disclosed" },
    ],
    ["dbs_application", "withdrawn", { outcome: "withdrawn" }],
    ["dbs_status_check", "new_information", { outcome: "new_information" }],
    ["nmc_register_check", "registered", { outcome: "registered", renewalDueOn: "2027-10-30" }],
    ["nmc_register_check", "conditions", { outcome: "registered_with_conditions" }],
    ["nmc_register_check", "not_registered", { outcome: "not_registered", renewalDueOn: null }],
  ])("%s %s", async (kind, scenario, expected) => {
    const mock = new MockVetting(kind, scenario, CLOCK);
    let answer: VettingAnswer<unknown> = await mock.start(REQUESTS[kind] as never);
    if (answer.state === "pending") answer = await mock.status(answer.externalReference);
    expect(answer.state).toBe("completed");
    if (answer.state === "completed") {
      expect(answer.result).toMatchObject({ checkedOn: "2026-10-31", ...expected });
    }
  });

  it("refuses an unknown scenario", () => {
    expect(() => new MockVetting("dbs_status_check", "hacked")).toThrow();
  });
});

describe("choosing the adapter (off by default)", () => {
  const mock = { provider: "mock", settings: {} };
  it.each<
    [string, { provider: string; settings: Record<string, unknown> } | null, boolean, boolean]
  >([
    ["no connection", null, false, false],
    ["no connection, production", null, true, false],
    ["the mock outside production", mock, false, true],
    ["the mock in production", mock, true, false],
    ["a provider this build does not know", { provider: "acme", settings: {} }, false, false],
  ])("%s", (_name, connection, production, on) => {
    for (const kind of Object.keys(MOCK_SCENARIOS) as VettingCheckKind[]) {
      expect(createVettingAdapter(kind, connection, { production }) !== null).toBe(on);
    }
  });

  it("every port knows only the mock until a vendor is contracted (H-521 to H-523)", () => {
    for (const providers of Object.values(KNOWN_VETTING_PROVIDERS)) {
      expect(providers).toEqual(["mock"]);
    }
  });

  it("uses the connection's scenario, and the default for one it does not know", async () => {
    const chosen = createVettingAdapter(
      "nmc_register_check",
      { provider: "mock", settings: { scenario: "not_registered" } },
      { production: false, clock: CLOCK },
    );
    const answer = await chosen?.start(REQUESTS.nmc_register_check);
    expect(answer).toMatchObject({ state: "completed", result: { outcome: "not_registered" } });
    const fallback = createVettingAdapter(
      "nmc_register_check",
      { provider: "mock", settings: { scenario: "nonsense" } },
      { production: false, clock: CLOCK },
    );
    expect(await fallback?.start(REQUESTS.nmc_register_check)).toMatchObject({
      result: { outcome: "registered" },
    });
  });
});

describe("strict answers", () => {
  const rogue = (result: unknown, error = "provider_error") => ({
    provider: "rogue",
    health: async () => ({ ok: true, detail: "rogue" }),
    start: async () => ({ state: "completed" as const, externalReference: "r-1", result }) as never,
    status: async () => ({ state: "failed" as const, retryable: false, error }) as never,
  });

  it("refuses a DBS result carrying anything the certificate disclosed", async () => {
    const adapter = strictVetting(
      "dbs_application",
      rogue({
        outcome: "certificate_issued",
        checkedOn: "2026-10-31",
        issuedOn: "2026-10-31",
        certificateNumber: "009999999999",
        level: "enhanced_adults_barred",
        result: "information_disclosed",
        disclosure: "Never stored",
      }),
    );
    expect(await adapter.start(REQUESTS.dbs_application)).toEqual({
      state: "failed",
      retryable: false,
      error: "invalid_answer",
    });
  });

  it("keeps provider error text out, as a short code", async () => {
    const adapter = strictVetting(
      "nmc_register_check",
      rogue(null, "Ada Example's PIN 99A9999E was not found"),
    );
    expect(await adapter.status("x")).toEqual({
      state: "failed",
      retryable: false,
      error: "provider_error",
    });
  });

  it("turns a thrown adapter error into a retryable failure", async () => {
    const adapter = strictVetting("nmc_register_check", {
      ...rogue(null),
      start: async () => {
        throw new Error("socket hang up with personal data");
      },
    });
    expect(await adapter.start(REQUESTS.nmc_register_check)).toEqual({
      state: "failed",
      retryable: true,
      error: "provider_error",
    });
  });
});

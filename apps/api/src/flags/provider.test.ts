import { ErrorCode, OpenFeature } from "@openfeature/server-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config";
import { createLogger } from "../logger";
import { FlagsmithFlags, type RemoteFlags } from "./flagsmith";
import { createFlagService, HarbourFlagProvider } from "./provider";

const config = loadConfig({ NODE_ENV: "test" });
const logger = createLogger("silent");
const TENANT = "0194d000-0000-7000-8000-000000000001";
const LOC = "0194d000-0000-7000-8000-000000000101";
let domains = 0;
const domain = () => `test-${++domains}`;

function remoteOf(flags: Record<string, boolean> | null): RemoteFlags & { calls: number } {
  const remote = {
    calls: 0,
    flagsFor: async () => {
      remote.calls += 1;
      return flags ? new Map(Object.entries(flags)) : null;
    },
  };
  return remote;
}

afterEach(() => vi.restoreAllMocks());

describe("the OpenFeature provider over the flag catalogue (PLAT-003)", () => {
  it("evaluates the location row, the tenant row, Flagsmith, then the catalogue", async () => {
    const remote = remoteOf({
      "module.public_site": true,
      "module.workforce": false,
      "module.finance": true,
      "module.emar": true,
      "module.residential": false,
      "module.family_portal": true,
      "module.ai": true,
      "care.tool.waterlow": true,
      "dols.post_2026_review_workflow": false,
    });
    const flags = await createFlagService(config, logger, domain(), remote).evaluateAll({
      tenantId: TENANT,
      locationId: LOC,
      overrides: [
        { flagKey: "module.domiciliary", locationId: LOC, enabled: true },
        { flagKey: "module.domiciliary", locationId: null, enabled: false },
        { flagKey: "module.workforce", locationId: null, enabled: true },
        { flagKey: "module.supported_living", locationId: "another-location", enabled: true },
      ],
    });
    expect(flags["module.domiciliary"]).toBe(true); // location row
    expect(flags["module.workforce"]).toBe(true); // tenant row over Flagsmith
    expect(flags["module.supported_living"]).toBe(false); // another location's row does not apply
    expect(flags["module.public_site"]).toBe(true); // Flagsmith, a flag marked remote
    // Flagsmith never sets a clinical or data-protection module, AI, a clinical tool or a review
    // workflow (#39 review M1).
    expect(flags["module.finance"]).toBe(false);
    expect(flags["module.emar"]).toBe(false);
    expect(flags["module.residential"]).toBe(true);
    expect(flags["module.family_portal"]).toBe(false);
    expect(flags["module.ai"]).toBe(false);
    expect(flags["care.tool.waterlow"]).toBe(false);
    expect(flags["dols.post_2026_review_workflow"]).toBe(true);
    expect(flags["locale.welsh"]).toBe(false);
  });

  it("turns AI on only where the organisation's own row says so", async () => {
    const service = createFlagService(config, logger, domain(), remoteOf({}));
    const at = (overrides: { flagKey: string; locationId: string | null; enabled: boolean }[]) =>
      service.evaluateAll({ tenantId: TENANT, locationId: LOC, overrides });
    expect((await at([]))["module.ai"]).toBe(false);
    expect(
      (await at([{ flagKey: "module.ai", locationId: null, enabled: true }]))["module.ai"],
    ).toBe(true);
  });

  it("falls back to the catalogue when Flagsmith does not answer, asking once per period", async () => {
    let now = 1_000_000;
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const remote = new FlagsmithFlags(
      {
        apiUrl: "http://flags.invalid/api/v1",
        environmentKey: "test-key",
        timeoutMs: 50,
        cacheSeconds: 60,
      },
      logger,
      fetchFn as unknown as typeof fetch,
      () => now,
    );
    const service = createFlagService(config, logger, domain(), remote);
    const input = { tenantId: TENANT, locationId: null, overrides: [] };
    const flags = await service.evaluateAll(input);
    expect(flags["module.residential"]).toBe(true);
    expect(flags["module.workforce"]).toBe(false);
    await service.evaluateAll(input);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 61_000;
    await service.evaluateAll(input);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("never asks Flagsmith when no key is configured, or about a flag the organisation set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await createFlagService(config, logger, domain()).evaluateAll({
      tenantId: TENANT,
      locationId: null,
      overrides: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    const remote = remoteOf({ "module.workforce": true });
    const provider = new HarbourFlagProvider(remote);
    const result = await provider.resolveBooleanEvaluation("module.workforce", false, {
      tenantId: TENANT,
      locationId: null,
      overrides: [{ flagKey: "module.workforce", locationId: null, enabled: false }],
    });
    expect(result).toMatchObject({ value: false, variant: "tenant", reason: "TARGETING_MATCH" });
    expect(remote.calls).toBe(0);
  });

  it("keeps the organisation's own rows when the provider fails (#39 review L1)", async () => {
    const failing: RemoteFlags = {
      flagsFor: () => Promise.reject(new Error("provider failure")),
    };
    const service = createFlagService(config, logger, domain(), failing);
    // A context the provider refuses (no organisation): every evaluation fails inside it.
    const flags = await service.evaluateAll({
      tenantId: "",
      locationId: LOC,
      overrides: [
        { flagKey: "module.emar", locationId: LOC, enabled: true },
        { flagKey: "module.residential", locationId: null, enabled: false },
        { flagKey: "module.ai", locationId: null, enabled: true },
      ],
    });
    expect(flags["module.emar"]).toBe(true);
    expect(flags["module.residential"]).toBe(false);
    expect(flags["module.ai"]).toBe(true);
    expect(flags["care.tool.waterlow"]).toBe(false);
    // Flagsmith failing for a flag it may set: the catalogue default, not an error.
    const remoteFailed = await service.evaluateAll({
      tenantId: TENANT,
      locationId: null,
      overrides: [],
    });
    expect(remoteFailed["module.workforce"]).toBe(false);
    expect(remoteFailed["module.residential"]).toBe(true);
  });

  it("answers the caller's default for an unknown flag or a context without an organisation", async () => {
    const name = domain();
    OpenFeature.setProvider(name, new HarbourFlagProvider(null));
    const client = OpenFeature.getClient(name);
    const unknown = await client.getBooleanDetails("module.unknown", false, {
      tenantId: TENANT,
      locationId: null,
      overrides: [],
    });
    expect(unknown).toMatchObject({ value: false, errorCode: ErrorCode.FLAG_NOT_FOUND });
    const noTenant = await client.getBooleanDetails("module.ai", false, {});
    expect(noTenant).toMatchObject({ value: false, errorCode: ErrorCode.INVALID_CONTEXT });
    const notBoolean = await client.getStringDetails("module.ai", "off", {});
    expect(notBoolean).toMatchObject({ value: "off", errorCode: ErrorCode.TYPE_MISMATCH });
  });
});

describe("Flagsmith (optional, H-13)", () => {
  const options = {
    apiUrl: "http://flags.invalid/api/v1/",
    environmentKey: "test-key",
    timeoutMs: 50,
    cacheSeconds: 60,
  };

  it("asks with the environment key and opaque ids only, and reads the flags", async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({ flags: [{ enabled: true, feature: { name: "module.workforce" } }] }),
          { status: 200 },
        ),
    );
    const remote = new FlagsmithFlags(options, logger, fetchFn as unknown as typeof fetch);
    const flags = await remote.flagsFor({ tenantId: TENANT, locationId: LOC });
    expect(flags?.get("module.workforce")).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] ?? ["", {}];
    expect(url).toBe("http://flags.invalid/api/v1/identities/");
    expect(new Headers(init.headers).get("x-environment-key")).toBe("test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      identifier: `${TENANT}:${LOC}`,
      traits: [
        { trait_key: "tenant_id", trait_value: TENANT },
        { trait_key: "location_id", trait_value: LOC },
      ],
    });
  });

  it.each([
    ["an error status", () => new Response("{}", { status: 503 })],
    ["an unreadable reply", () => new Response(JSON.stringify({ flags: "no" }), { status: 200 })],
  ])("reads %s as no answer", async (_name, reply) => {
    const remote = new FlagsmithFlags(options, logger, (async () => reply()) as typeof fetch);
    expect(await remote.flagsFor({ tenantId: TENANT, locationId: null })).toBeNull();
  });
});

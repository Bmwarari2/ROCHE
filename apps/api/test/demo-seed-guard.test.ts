import { describe, expect, it } from "vitest";
import {
  demoTenantRefusal,
  testOnlySwitchRefusal,
  wantsTestOnlySwitch,
} from "../scripts/demo-seed-guard";

/**
 * The demo seed's test-only switches (the public e2e passkey, MFA off) run only against a local or
 * CI database in the demo tenant (#63 security review of 13f170b, HZ-112).
 */

const LOCAL = "postgres://harbour_owner:harbour_owner_local@localhost:5432/harbour";
const DEMO_TENANT = "0194d000-0000-7000-8000-000000000001";

describe("which switches are test-only", () => {
  it.each([
    [{ HARBOUR_DEMO_E2E_PASSKEY: "1" }, true],
    [{ HARBOUR_DEMO_MFA: "off" }, true],
    [{ HARBOUR_DEMO_E2E_PASSKEY: "0", HARBOUR_DEMO_MFA: "on" }, false],
    [{}, false],
  ])("%o -> %s", (env, wanted) => {
    expect(wantsTestOnlySwitch(env)).toBe(wanted);
  });
});

describe("the test-only switches are refused off a local database", () => {
  const cases: readonly {
    name: string;
    env?: Record<string, string>;
    nodeEnv?: string;
    urls?: string[];
    refused: RegExp | null;
  }[] = [
    { name: "local development database", refused: null },
    { name: "local test database", nodeEnv: "test", refused: null },
    { name: "127.0.0.1", urls: ["postgres://u:p@127.0.0.1:5432/harbour"], refused: null },
    { name: "::1", urls: ["postgres://u:p@[::1]:5432/harbour"], refused: null },
    {
      name: "the CI service container in CI",
      env: { CI: "true" },
      urls: ["postgres://u:p@postgres:5432/harbour"],
      refused: null,
    },
    {
      name: "the CI service host outside CI",
      urls: ["postgres://u:p@postgres:5432/harbour"],
      refused: /points at postgres/,
    },
    { name: "NODE_ENV production", nodeEnv: "production", refused: /NODE_ENV is production/ },
    { name: "HARBOUR_ENV dev", env: { HARBOUR_ENV: "dev" }, refused: /HARBOUR_ENV is dev/ },
    {
      name: "HARBOUR_ENV staging",
      env: { HARBOUR_ENV: "staging" },
      refused: /HARBOUR_ENV is staging/,
    },
    { name: "HARBOUR_ENV pilot", env: { HARBOUR_ENV: "Pilot" }, refused: /HARBOUR_ENV is pilot/ },
    {
      name: "a Supabase London host",
      urls: [LOCAL, "postgres://u:p@db.abcdefgh.supabase.co:5432/postgres"],
      refused: /points at db\.abcdefgh\.supabase\.co/,
    },
    {
      name: "an RDS host even in CI",
      env: { CI: "true" },
      urls: ["postgres://u:p@harbour.cluster.eu-west-2.rds.amazonaws.com/harbour"],
      refused: /points at harbour\.cluster/,
    },
    { name: "an unreadable URL", urls: ["not a url"], refused: /unreadable host/ },
  ];
  it.each(cases)("$name", ({ env = {}, nodeEnv = "development", urls = [LOCAL], refused }) => {
    const refusal = testOnlySwitchRefusal({ env, nodeEnv, databaseUrls: urls });
    if (refused === null) expect(refusal).toBeNull();
    else expect(refusal).toMatch(refused);
  });
});

describe("the test-only switches change only the demo tenant", () => {
  it.each([
    [DEMO_TENANT, null],
    ["0194d000-0000-7000-8000-000000000999", /not linked in the demo tenant/],
    [null, /not linked in the demo tenant/],
  ])("%s", (linked, refused) => {
    const refusal = demoTenantRefusal(linked, DEMO_TENANT);
    if (refused === null) expect(refusal).toBeNull();
    else expect(refusal).toMatch(refused);
  });
});

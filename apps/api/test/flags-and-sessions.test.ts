import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/** PLAT-003: `/v1/me` evaluates flags through the OpenFeature provider. */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

async function asTenant(sql: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

const me = (session: { token: string }) =>
  h.request("/v1/me", { tenant: DEMO.tenantId, token: session.token });

describe("flags through the OpenFeature provider (PLAT-003)", () => {
  it("leaves out an override that was deleted", async () => {
    await asTenant(
      "INSERT INTO feature_flag (flag_key, enabled, deleted_at) VALUES ('module.finance', true, now())",
    );
    try {
      const before = (await (await me({ token: h.tokens.carer ?? "" })).json()) as {
        flags: Record<string, boolean>;
      };
      expect(before.flags["module.finance"]).toBe(false);
      expect(before.flags["module.ai"]).toBe(false);
      await asTenant("UPDATE feature_flag SET deleted_at = NULL WHERE flag_key = 'module.finance'");
      const after = (await (await me({ token: h.tokens.carer ?? "" })).json()) as {
        flags: Record<string, boolean>;
      };
      expect(after.flags["module.finance"]).toBe(true);
    } finally {
      await asTenant("DELETE FROM feature_flag WHERE flag_key = 'module.finance'");
    }
  });
});

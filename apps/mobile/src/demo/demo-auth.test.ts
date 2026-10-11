import { describe, expect, it } from "vitest";
import { createDemoAuthClient, DEMO_TOKEN, DEMO_TOTP_CODE } from "./demo-auth";
import { demoMe } from "./demo-data";

describe("demo auth client", () => {
  const client = createDemoAuthClient();

  it("signs in with any non-empty details", async () => {
    await expect(client.signInWithEmail("ada@example.invalid", "x")).resolves.toEqual({
      kind: "signed_in",
      token: DEMO_TOKEN,
    });
  });

  it("refuses empty details", async () => {
    await expect(client.signInWithEmail(" ", "x")).rejects.toMatchObject({
      kind: "invalid_credentials",
    });
  });

  it("exercises the TOTP step", async () => {
    const result = await client.signInWithEmail("ada+totp@example.invalid", "x");
    expect(result.kind).toBe("two_factor_required");
    if (result.kind !== "two_factor_required") return;
    await expect(client.verifyTotp(result.challenge, "000000")).rejects.toMatchObject({
      kind: "invalid_code",
    });
    await expect(client.verifyTotp(result.challenge, DEMO_TOTP_CODE)).resolves.toBe(DEMO_TOKEN);
  });

  it("returns an invented user and tenant", async () => {
    await expect(client.getMe(DEMO_TOKEN)).resolves.toEqual(demoMe);
    expect(demoMe.tenant.name).toMatch(/demo/);
  });
});

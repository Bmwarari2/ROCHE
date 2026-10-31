import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The end-to-end loopback flag (env.ts) allows plain http to the phone's own loopback. It belongs
 * to the CI workflow's emulator build only: no EAS profile, and so no binary built for a store or
 * for testers, may carry it or the cleartext switch it needs (app.config.ts).
 */
const eas = JSON.parse(readFileSync(new URL("../../eas.json", import.meta.url), "utf8")) as {
  build: Record<string, { env?: Record<string, string> }>;
};

describe("EAS build profiles never carry the end-to-end loopback build", () => {
  it.each(Object.keys(eas.build))("%s", (name) => {
    const env = eas.build[name]?.env ?? {};
    expect(env.EXPO_PUBLIC_E2E_LOOPBACK).toBeUndefined();
    expect(env.HARBOUR_E2E_BUILD).toBeUndefined();
  });
});

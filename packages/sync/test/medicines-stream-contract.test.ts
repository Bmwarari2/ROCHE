import { describe, expect, it } from "vitest";
import { readSyncConfig } from "../src/streams/index";

/**
 * The medicines round stream is a contract only until slice 68 (medicines.md section 13.8; slice
 * 22). Replication bypasses row-level security, so no medicines table may reach a device until
 * the stream and its isolation tests land together. This test fails if a medicines table appears
 * in the sync configuration first: slice 68 replaces it with the stream's isolation tests.
 */
describe("hazard HZ-011 the medicines round stream is a contract until slice 68", () => {
  it("publishes no medicines table to devices yet", () => {
    expect(readSyncConfig()).not.toMatch(/\bmedication(_[a-z_]+)?\b/);
  });
});

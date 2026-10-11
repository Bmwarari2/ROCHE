import { describe, expect, it } from "vitest";
import { type SyncSummaryInput, syncSummary } from "./sync-summary";

const NOW = new Date("2026-10-11T13:00:00Z");
const FIFTEEN_MINUTES = 15 * 60_000;

const input = (overrides: Partial<SyncSummaryInput> = {}): SyncSummaryInput => ({
  lastSyncedAt: new Date("2026-10-11T12:55:00Z"),
  queued: 0,
  issues: 0,
  held: 0,
  demo: false,
  windowDays: 7,
  now: NOW,
  staleAfterMs: FIFTEEN_MINUTES,
  ...overrides,
});

describe("hazard HZ-002 the sync status on Today", () => {
  it("gives the exact time of the last successful sync in UK time and the queued changes", () => {
    const summary = syncSummary(input({ queued: 2 }));
    expect(summary).toMatchObject({
      headline: "Last successful sync 11/10/2026 at 13:55",
      queued: "2 changes waiting to upload",
      issues: null,
      window: "Entries from the last 7 days are kept on this device.",
      tone: "info",
      icon: "cloud-upload",
      stale: false,
    });
  });

  it("hazard HZ-028 says how many days of entries the device keeps", () => {
    expect(syncSummary(input({ windowDays: 1 })).window).toBe(
      "Entries from today are kept on this device.",
    );
    expect(syncSummary(input({ windowDays: 14 })).window).toBe(
      "Entries from the last 14 days are kept on this device.",
    );
  });

  it("warns once the data is older than the threshold", () => {
    const summary = syncSummary(input({ lastSyncedAt: new Date("2026-10-11T09:00:00Z") }));
    expect(summary).toMatchObject({ tone: "warning", icon: "triangle-alert", stale: true });
  });

  it("says when the device has never synced", () => {
    const summary = syncSummary(input({ lastSyncedAt: null, windowDays: null }));
    expect(summary).toMatchObject({
      headline: "Not synced yet. Connect to the internet to download your people.",
      queued: "No changes waiting to upload",
      window: null,
    });
    expect(summary.stale).toBe(true);
  });

  it("hazard HZ-006 puts refused entries first in importance", () => {
    const summary = syncSummary(input({ issues: 1, queued: 3 }));
    expect(summary.issues).toBe("1 entry was not saved and needs attention");
    expect(summary).toMatchObject({ tone: "danger", icon: "cloud-alert", needsAttention: true });
  });

  it("hazard HZ-006 never reads up to date while entries are still held (clinical review M2)", () => {
    const summary = syncSummary(input({ held: 2 }));
    expect(summary.held).toBe(
      "2 entries from before the session ended are still held on this device and not yet back in the upload queue. Harbour tries again each time it unlocks.",
    );
    expect(summary).toMatchObject({ tone: "danger", icon: "cloud-alert", needsAttention: true });
    expect(syncSummary(input()).held).toBeNull();
  });

  it("hazard HZ-006 reads held entries that could not be counted as needing attention (round 4, M4)", () => {
    const summary = syncSummary(input({ held: null }));
    expect(summary.held).toBe(
      "Some entries on this device could not be counted and need attention. Harbour tries again each time it unlocks.",
    );
    expect(summary).toMatchObject({ tone: "danger", icon: "cloud-alert", needsAttention: true });
  });

  it("says plainly that demo entries never upload", () => {
    const summary = syncSummary(input({ demo: true, lastSyncedAt: null }));
    expect(summary).toMatchObject({
      headline: "Demo mode: entries stay on this device and are never uploaded.",
      queued: null,
      window: null,
    });
    expect(summary.stale).toBe(false);
  });
});

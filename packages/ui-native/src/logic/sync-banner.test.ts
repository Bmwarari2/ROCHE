import { describe, expect, it } from "vitest";
import {
  describeSyncBanner,
  NEVER_SYNCED_WARNING,
  REFUSED_TITLE,
  STALE_WARNING,
} from "./sync-banner";

const now = new Date("2026-10-09T13:05:00Z");
const staleAfterMs = 15 * 60_000;
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("describeSyncBanner", () => {
  it("shows up to date with the last sync time when fresh", () => {
    const content = describeSyncBanner({
      state: "synced",
      lastSyncedAt: minutesAgo(2),
      now,
      staleAfterMs,
    });
    expect(content).toMatchObject({
      tone: "success",
      icon: "circle-check",
      title: "Up to date",
      detail: "Last synced 2 minutes ago.",
      warning: null,
      stale: false,
      showRetry: false,
      urgent: false,
    });
  });

  it("shows offline without alarm while the data is still fresh", () => {
    const content = describeSyncBanner({
      state: "offline",
      lastSyncedAt: minutesAgo(5),
      now,
      staleAfterMs,
    });
    expect(content.title).toBe("Offline");
    expect(content.tone).toBe("neutral");
    expect(content.icon).toBe("wifi-off");
    expect(content.warning).toBeNull();
  });

  it("warns that offline data may be out of date past the threshold (HZ-002)", () => {
    const content = describeSyncBanner({
      state: "offline",
      lastSyncedAt: minutesAgo(180),
      now,
      staleAfterMs,
    });
    expect(content).toMatchObject({
      tone: "warning",
      icon: "triangle-alert",
      title: "Offline",
      detail: "Last synced 3 hours ago.",
      warning: STALE_WARNING,
      stale: true,
      urgent: true,
    });
    expect(content.accessibilityLabel).toBe(`Offline. Last synced 3 hours ago. ${STALE_WARNING}`);
  });

  it("keeps the stale warning even when connected but not yet caught up", () => {
    const content = describeSyncBanner({
      state: "syncing",
      lastSyncedAt: minutesAgo(60),
      now,
      staleAfterMs,
    });
    expect(content.warning).toBe(STALE_WARNING);
    expect(content.tone).toBe("warning");
  });

  it("never fails silently: a failure is danger, urgent and offers retry (HZ-006)", () => {
    const content = describeSyncBanner({
      state: "failed",
      lastSyncedAt: minutesAgo(1),
      now,
      staleAfterMs,
      queuedChanges: 3,
    });
    expect(content).toMatchObject({
      tone: "danger",
      icon: "cloud-alert",
      title: "Sync failed",
      detail: "Last synced 1 minute ago. 3 changes waiting to upload.",
      showRetry: true,
      urgent: true,
    });
  });

  it("uses the singular for one queued change", () => {
    const content = describeSyncBanner({
      state: "syncing",
      lastSyncedAt: minutesAgo(0),
      now,
      staleAfterMs,
      queuedChanges: 1,
    });
    expect(content.detail).toBe("Last synced just now. 1 change waiting to upload.");
    expect(content.tone).toBe("info");
  });

  it("explains an empty device before the first sync", () => {
    const offline = describeSyncBanner({ state: "offline", lastSyncedAt: null, now, staleAfterMs });
    expect(offline.detail).toBe("Not synced yet.");
    expect(offline.warning).toBe(NEVER_SYNCED_WARNING);
    expect(offline.stale).toBe(true);

    const syncing = describeSyncBanner({ state: "syncing", lastSyncedAt: null, now, staleAfterMs });
    expect(syncing.warning).toBeNull();
    expect(syncing.tone).toBe("info");
  });
});

describe("hazard HZ-006 refused entries on the banner (clinical review C1)", () => {
  it.each(["synced", "syncing", "offline", "failed"] as const)(
    "never reads up to date while a refused entry is on the device (%s)",
    (state) => {
      const content = describeSyncBanner({
        state,
        lastSyncedAt: minutesAgo(1),
        now,
        staleAfterMs,
        refusedEntries: 2,
      });
      expect(content.title).not.toBe("Up to date");
      expect(content.detail).toContain("2 entries were not saved and need attention.");
      expect(content.tone).toBe("danger");
      expect(content.icon).toBe("cloud-alert");
      expect(content.urgent).toBe(true);
    },
  );

  it("says not all saved instead of up to date", () => {
    const content = describeSyncBanner({
      state: "synced",
      lastSyncedAt: minutesAgo(1),
      now,
      staleAfterMs,
      refusedEntries: 1,
    });
    expect(content.title).toBe(REFUSED_TITLE);
    expect(content.detail).toBe(
      "Last synced 1 minute ago. 1 entry was not saved and needs attention.",
    );
  });

  it("reads up to date again once none is left", () => {
    const content = describeSyncBanner({
      state: "synced",
      lastSyncedAt: minutesAgo(1),
      now,
      staleAfterMs,
      refusedEntries: 0,
    });
    expect(content.title).toBe("Up to date");
    expect(content.tone).toBe("success");
  });
});

import { SyncBanner } from "@harbour/ui-native";
import { SCOPE_TOO_LARGE_REASON, STALE_WARNING } from "@harbour/ui-native/logic";
import { createElement } from "react";
import { AccessibilityInfo } from "react-native";
import { describe, expect, it } from "vitest";
import { announceRefusalOnce, setScopeRefused } from "../sync/scope-refusal-store";
import { render } from "../test-support/render";

/**
 * Hazard HZ-138 and HZ-002 (ADR-0134): a phone refused because the member's access is too wide
 * says so in words on every screen, with what to do and that their changes are safe, beside the
 * stale-data warning, with a Retry button whose hint does not promise a fix; the refusal is
 * announced once rather than re-read every minute (accessibility review of the refusal banner).
 */

describe("hazard HZ-138 the banner when a phone is refused for too wide access", () => {
  it("shows the refusal, what to do and the stale-data warning, with Retry", async () => {
    const view = await render(
      createElement(SyncBanner, {
        state: "failed",
        lastSyncedAt: new Date(Date.now() - 2 * 3_600_000),
        staleAfterMs: 3_600_000,
        failureReason: "scope_too_large",
        onRetry: () => undefined,
      }),
    );
    const texts = view.texts().join(" ");
    expect(texts).toContain("This phone cannot sync");
    expect(texts).toContain(SCOPE_TOO_LARGE_REASON);
    expect(texts).toContain(STALE_WARNING);
    expect(view.find("sync-banner-reason")).toBeTruthy();
    const retry = view.find("sync-banner-retry");
    expect(retry?.props.accessibilityLabel).toBe("Retry sync");
    expect(retry?.props.accessibilityHint).toBe("Checks again whether this phone can sync");
  });

  it("announces the refusal once across every screen's banner, again only when the stale warning appears, and keeps it out of the live region", async () => {
    const announced = (AccessibilityInfo as unknown as { announced: string[] }).announced;
    announced.length = 0;
    setScopeRefused(true);
    const banner = (lastSyncedAt: Date) =>
      createElement(SyncBanner, {
        state: "failed",
        lastSyncedAt,
        staleAfterMs: 3_600_000,
        failureReason: "scope_too_large",
        announce: announceRefusalOnce,
        onRetry: () => undefined,
      });
    const fresh = new Date(Date.now() - 60_000);
    const first = await render(banner(fresh));
    await render(banner(fresh));
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain(SCOPE_TOO_LARGE_REASON);
    const message = first.find("sync-banner-message");
    expect(message?.props.accessibilityLiveRegion).toBe("none");
    // The data goes stale: said once more, with the warning.
    await render(banner(new Date(Date.now() - 2 * 3_600_000)));
    expect(announced).toHaveLength(2);
    expect(announced[1]).toContain(STALE_WARNING);
    // Cleared, then refused again: said again.
    setScopeRefused(false);
    setScopeRefused(true);
    await render(banner(fresh));
    expect(announced).toHaveLength(3);
    setScopeRefused(false);
  });
});

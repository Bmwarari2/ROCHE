import { SyncBanner } from "@harbour/ui-native";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { restoreProblem } from "../app-state/held-work";
import { t } from "../i18n/t";
import { render } from "../test-support/render";
import { RestoreProblemNotice } from "./RestoreProblemNotice";

/**
 * Hazard HZ-006 (loss of offline records), clinical review round 4, M4: when held entries could
 * not be put back after sign-in, the person is told, in words, on every screen; and a banner whose
 * count of entries needing attention is unknown never reads "Up to date".
 */

describe("hazard HZ-006 held entries that could not be put back are shown, not hidden", () => {
  it("says, as an alert, that the whole restore failed", async () => {
    const message = restoreProblem("failed");
    if (!message) throw new Error("expected a message");
    const view = await render(createElement(RestoreProblemNotice, { message }));
    expect(view.texts()).toEqual([t("mobile.vault.restoreFailed")]);
    expect(view.find("restore-problem")?.props.accessibilityRole).toBe("alert");
  });

  it("says how many are still held when only some could not go back", async () => {
    const message = restoreProblem({ restored: 1, parked: 0, remaining: 2 });
    if (!message) throw new Error("expected a message");
    const view = await render(createElement(RestoreProblemNotice, { message }));
    expect(view.texts()[0]).toMatch(/^2 unsent entries could not be put back to be sent\./);
  });

  it("reads an unknown count as needing attention on the banner, never up to date", async () => {
    const view = await render(
      createElement(SyncBanner, {
        state: "synced",
        lastSyncedAt: new Date(),
        staleAfterMs: 3_600_000,
        queuedChanges: 0,
        refusedEntries: null,
        onRetry: () => undefined,
      }),
    );
    const texts = view.texts().join(" ");
    expect(texts).toContain("Not all saved");
    expect(texts).toContain("Some entries on this device could not be counted and need attention.");
    expect(texts).not.toContain("Up to date");
  });
});

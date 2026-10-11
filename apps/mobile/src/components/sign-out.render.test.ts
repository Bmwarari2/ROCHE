import { createElement } from "react";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it } from "vitest";
import type { DiscardReason } from "../app-state/held-work";
import { t } from "../i18n/t";
import { render, settle } from "../test-support/render";
import { DeleteWithReason } from "./DeleteWithReason";
import { type SignOutActions, SignOutControlView } from "./SignOutControlView";

/**
 * Sign-out with entries that have not reached the server (clinical review C2; security reviews S4
 * and M1), rendered: the count is named, a coded reason is needed, the confirmation names the
 * count again, and only then is the vault asked to delete.
 */

interface RecordedAlert {
  readonly title: string;
  readonly buttons?: ReadonlyArray<{ text?: string; onPress?: () => void }>;
}
const alerts = (Alert as unknown as { calls: RecordedAlert[] }).calls;

function actions(count: number | null, failure?: Error) {
  const calls = { wiped: 0, discarded: [] as Array<[DiscardReason, number | null]> };
  const value: SignOutActions = {
    countUnsent: async () => count,
    signOutAndWipe: async () => {
      calls.wiped += 1;
    },
    signOutDiscarding: async (choice, n) => {
      if (failure) throw failure;
      calls.discarded.push([choice, n]);
    },
  };
  return { value, calls };
}

async function answer(index: number, button: string) {
  const buttons = alerts[index]?.buttons ?? [];
  const chosen = buttons.find((b) => b.text === button);
  if (!chosen?.onPress) throw new Error(`no ${button} button`);
  chosen.onPress();
  await settle();
}

beforeEach(() => {
  alerts.length = 0;
});

describe("hazard HZ-006 signing out with unsent entries (C2)", () => {
  it("asks a plain confirmation when nothing is unsent", async () => {
    const { value, calls } = actions(0);
    const view = await render(
      createElement(SignOutControlView, {
        actions: value,
        variant: "secondary",
        testID: "sign-out",
      }),
    );
    await view.press("sign-out");
    expect(alerts[0]?.title).toBe(t("mobile.signOut.title"));
    await answer(0, t("mobile.signOut.button"));
    expect(calls.wiped).toBe(1);
  });

  it("hazard HZ-040 names the count, needs a coded reason and confirms the count again", async () => {
    const { value, calls } = actions(3);
    const view = await render(
      createElement(SignOutControlView, {
        actions: value,
        variant: "secondary",
        testID: "sign-out",
      }),
    );
    await view.press("sign-out");
    expect(view.texts()).toContain("3 entries have not reached the server and will be deleted.");
    // No reason yet: nothing is asked or deleted.
    await view.press("sign-out-discard-confirm");
    expect(view.texts()).toContain(t("mobile.discard.reasonCodeRequired"));
    expect(alerts).toHaveLength(0);
    // A coded reason, then the confirmation naming the count.
    await view.press("sign-out-discard-code-staff_left");
    await view.press("sign-out-discard-confirm");
    expect(alerts[0]?.title).toBe("Delete 3 unsent entries?");
    await answer(0, t("mobile.held.discardConfirm"));
    expect(calls.discarded).toEqual([[{ reasonCode: "staff_left", reason: "" }, 3]]);
    expect(calls.wiped).toBe(0);
  });

  it("hazard HZ-040 offers the listed reasons only: no Other and no words, which the deletion would remove (round 4, M3)", async () => {
    const { value, calls } = actions(1);
    const view = await render(
      createElement(SignOutControlView, {
        actions: value,
        variant: "secondary",
        testID: "sign-out",
      }),
    );
    await view.press("sign-out");
    expect(view.find("sign-out-discard-code-other")).toBeNull();
    expect(view.find("sign-out-discard-reason")).toBeNull();
    expect(view.texts()).not.toContain(t("mobile.discard.wordsLabel"));
    await view.press("sign-out-discard-code-entered_in_error");
    await view.press("sign-out-discard-confirm");
    await answer(0, t("mobile.held.discardConfirm"));
    expect(calls.discarded).toEqual([[{ reasonCode: "entered_in_error", reason: "" }, 1]]);
  });

  it("says when the count cannot be known while the database is closed", async () => {
    const view = await render(
      createElement(SignOutControlView, {
        actions: actions(null).value,
        variant: "secondary",
        testID: "sign-out",
      }),
    );
    await view.press("sign-out");
    expect(view.texts()).toContain(t("mobile.signOut.unsentUnknown"));
  });

  it("shows why nothing was deleted when the deletion could not be put on record", async () => {
    const { value } = actions(2, new Error(t("mobile.discard.needsConnection")));
    const view = await render(
      createElement(SignOutControlView, {
        actions: value,
        variant: "secondary",
        testID: "sign-out",
      }),
    );
    await view.press("sign-out");
    await view.press("sign-out-discard-code-recorded_elsewhere");
    await view.press("sign-out-discard-confirm");
    await answer(0, t("mobile.held.discardConfirm"));
    expect(view.texts()).toContain(t("mobile.discard.needsConnection"));
  });
});

describe("hazard HZ-040 removing one refused entry (round 4, M3)", () => {
  it("offers Other with the person's own words, which stay on the device", async () => {
    const removed: DiscardReason[] = [];
    const view = await render(
      createElement(DeleteWithReason, {
        buttonLabel: t("mobile.issues.remove"),
        confirmTitle: t("mobile.issues.removeTitle"),
        confirmBody: t("mobile.issues.removeBody"),
        reasonLabel: t("mobile.issues.removeReason"),
        onConfirm: async (choice) => {
          removed.push(choice);
        },
        withWords: true,
        testID: "remove",
      }),
    );
    await view.press("remove");
    expect(view.texts()).toContain(t("mobile.discard.wordsHint"));
    await view.press("remove-code-other");
    await view.press("remove-confirm");
    expect(view.texts()).toContain(t("mobile.discard.reasonRequired", { min: 3 }));
    await view.typeInto("remove-reason", "Recorded twice by mistake");
    await view.press("remove-confirm");
    await answer(0, t("mobile.held.discardConfirm"));
    expect(removed).toEqual([{ reasonCode: "other", reason: "Recorded twice by mistake" }]);
  });
});

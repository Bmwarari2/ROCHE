import { ListItem, SplitView } from "@harbour/ui-native";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type RoundTaskRow, roundItem } from "../care/round-view";
import { AccessibilityInfo } from "../test-support/react-native-stub";
import { render } from "../test-support/render";
import { RoundTaskCard } from "./RoundTaskCard";

/**
 * Tablet split views (MOB-013), rendered: the list before the detail in reading order, the
 * detail's heading naming who it shows before anything else in that pane (HZ-001), the screen
 * reader moved to that heading when the reader chooses another row, and the chosen row said in
 * words with an icon, never by colour alone. Invented people only.
 */

const NOW = new Date("2026-10-11T10:00:00.000Z");

interface Node {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<Node | string> | null;
}

/** Test ids in tree order: the order a screen reader and a keyboard go through them. */
function order(nodes: readonly Node[]): string[] {
  const out: string[] = [];
  const walk = (node: Node | string) => {
    if (typeof node === "string") return;
    if (typeof node.props.testID === "string") out.push(node.props.testID);
    for (const child of node.children ?? []) walk(child);
  };
  for (const node of nodes) walk(node);
  return out;
}

function split(detailKey: string | null, detailTitle: string | null) {
  return createElement(SplitView, {
    testID: "split",
    listWidth: 420,
    detailKey,
    detailTitle,
    list: createElement(ListItem, {
      testID: "row-ada",
      title: "Ada Example",
      onPress: () => undefined,
      selected: detailKey === "ada",
      selectedLabel: "Open beside the list",
    }),
    detail: createElement(ListItem, { testID: "detail-body", title: "Record body" }),
  });
}

describe("SplitView", () => {
  it("puts the list first, then the detail's heading, then the detail", async () => {
    const view = await render(split("ada", "Record for Ada Example"));
    const ids = order(view.nodes() as Node[]);
    expect(ids.indexOf("split-list")).toBeLessThan(ids.indexOf("split-detail"));
    expect(ids.indexOf("row-ada")).toBeLessThan(ids.indexOf("split-detail-title"));
    expect(ids.indexOf("split-detail-title")).toBeLessThan(ids.indexOf("detail-body"));
    expect(view.find("split-list")?.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 420 })]),
    );
    const heading = view.find("split-detail-title");
    expect(heading?.props).toMatchObject({
      accessible: true,
      accessibilityRole: "header",
      accessibilityLabel: "Record for Ada Example",
    });
    expect(view.texts()).toContain("Record for Ada Example");
  });

  it("has no heading while nothing is chosen", async () => {
    const view = await render(split(null, null));
    expect(view.find("split-detail-title")).toBeNull();
  });

  it("moves the screen reader to the detail's heading when the reader chooses another row, not when it first draws", async () => {
    vi.useFakeTimers();
    const { act } = await import("react");
    // A variable module name keeps the test-only renderer out of the app's type graph.
    const rendererName = "react-test-renderer";
    const renderer = (await import(/* @vite-ignore */ rendererName)) as {
      create(
        element: unknown,
        options: { createNodeMock: () => unknown },
      ): { update(element: unknown): void; unmount(): void };
    };
    let tree: { update(element: unknown): void; unmount(): void } | null = null;
    const draw = async (element: unknown) => {
      await act(async () => {
        if (tree) tree.update(element);
        // Host refs are empty in the test renderer unless it is given something to stand for them.
        else tree = renderer.create(element, { createNodeMock: () => ({ native: true }) });
      });
      await act(async () => {
        vi.runAllTimers();
      });
    };
    try {
      AccessibilityInfo.focused.length = 0;
      await draw(split("ada", "Record for Ada Example"));
      expect(AccessibilityInfo.focused).toEqual([]);
      await draw(split("ada", "Record for Ada Example"));
      expect(AccessibilityInfo.focused).toEqual([]);
      await draw(split("bob", "Record for Bob Example"));
      expect(AccessibilityInfo.focused).toEqual([{ native: true }]);
      // Nothing chosen: nothing to move to.
      await draw(split(null, null));
      expect(AccessibilityInfo.focused).toHaveLength(1);
      // A choice whose heading is not drawn yet waits for it, then moves once (#73 review H1).
      await draw(split("cara", null));
      expect(AccessibilityInfo.focused).toHaveLength(1);
      await draw(split("cara", "Record for Cara Example"));
      expect(AccessibilityInfo.focused).toHaveLength(2);
      await draw(split("cara", "Record for Cara Example"));
      expect(AccessibilityInfo.focused).toHaveLength(2);
    } finally {
      (tree as { unmount(): void } | null)?.unmount();
      vi.useRealTimers();
    }
  });
});

describe("ListItem, chosen on a tablet", () => {
  it("says it is shown in words with an icon, and is announced as selected", async () => {
    const view = await render(split("ada", "Record for Ada Example"));
    const row = view.find("row-ada");
    expect(row?.props.accessibilityState).toEqual({ selected: true });
    // Said once, as the platform's "selected", not again in the name (#73 accessibility review L7).
    expect(row?.props.accessibilityLabel).toBe("Ada Example");
    expect(view.find("row-ada-selected")).not.toBeNull();
    expect(view.texts()).toContain("Open beside the list");
  });

  it("says nothing extra when not chosen, and keeps a 44 point target", async () => {
    const view = await render(split(null, null));
    const row = view.find("row-ada");
    expect(row?.props.accessibilityState).toEqual({ selected: false });
    expect(view.find("row-ada-selected")).toBeNull();
    const styleOf = row?.props.style as ((s: { pressed: boolean }) => unknown[]) | undefined;
    const style = styleOf?.({ pressed: false });
    expect(style).toEqual(expect.arrayContaining([expect.objectContaining({ minHeight: 44 })]));
  });
});

const ROW: RoundTaskRow = {
  id: "task-1",
  tenant_id: "tenant-a",
  person_id: "person-ada",
  location_id: "loc-north",
  title: "Reposition",
  status: "open",
  due_at: "2026-10-11T10:30:00.000Z",
  window_start: "2026-10-11T09:30:00.000Z",
  window_end: "2026-10-11T11:30:00.000Z",
  priority: "routine",
  evidence_required: 0,
  required_permission: "care.note.write",
  assignee_tenant_user_id: null,
  version: 3,
  queued_transition: null,
  from_earlier_plan: 0,
  preferred_name: "Ada",
  given_name: "Adaline",
  family_name: "Example",
  person_location_id: "loc-north",
  evidence_waiting: 0,
  evidence_refused: 0,
  communication_needs: null,
};

function card(extra: Record<string, unknown>) {
  const shown: string[] = [];
  const element = createElement(RoundTaskCard, {
    item: roundItem(ROW, NOW),
    manager: false,
    onMark: async () => null,
    onRecordEvidence: () => undefined,
    ...extra,
    ...(extra.onShowPerson ? { onShowPerson: () => shown.push("shown") } : {}),
  });
  return { element, shown };
}

describe("RoundTaskCard beside a record on a tablet (HZ-001)", () => {
  it("offers to show the person's record, naming them to the screen reader", async () => {
    const { element, shown } = card({ onShowPerson: true });
    const view = await render(element);
    const button = view.find("round-task-1-show");
    expect(button?.props.accessibilityLabel).toBe("Show record for Ada Example");
    await view.press("round-task-1-show");
    expect(shown).toEqual(["shown"]);
  });

  it("says in words whose record is shown, in place of the button", async () => {
    const view = await render(card({ onShowPerson: true, personShown: true }).element);
    expect(view.find("round-task-1-show")).toBeNull();
    expect(view.texts()).toContain("Record for Ada Example open beside the round");
  });

  it("offers nothing extra on a phone", async () => {
    const view = await render(card({}).element);
    expect(view.find("round-task-1-show")).toBeNull();
    expect(view.find("round-task-1-shown")).toBeNull();
  });
});

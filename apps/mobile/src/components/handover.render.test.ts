import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { FieldError } from "../care/entries";
import {
  type AcknowledgementState,
  type HandoverItemView,
  handoverStatusView,
} from "../care/handover-view";
import { render } from "../test-support/render";
import { HandoverLocationCard } from "./HandoverLocationCard";

/**
 * One home's handover, rendered: what an incoming carer reads and presses (screens gate items (a),
 * (d) and (e); HZ-018). Invented people only.
 */

const ITEM: HandoverItemView = {
  id: "i-1",
  key: "fall:src-1",
  position: 1,
  words: "Fall, written in a care note",
  person: "Ada Example",
  personId: "person-ada",
  when: "31/10/2026 at 03:10",
  communicationNeeds: 1,
  communicationLabel: "Communication need",
  lateAddition: true,
  newForReader: true,
};

function card(
  state: AcknowledgementState,
  items: readonly HandoverItemView[] | null = [ITEM],
  answer: FieldError | null = null,
) {
  const presses: number[] = [];
  const element = createElement(HandoverLocationCard, {
    locationId: "loc-north",
    locationName: "Example House",
    status: handoverStatusView({ kind: "unknown" }),
    latestOnly: true,
    items,
    empty: "This handover holds no items you can see on this phone.",
    acknowledgement: state,
    onAcknowledge: async () => {
      presses.push(1);
      return answer;
    },
  });
  return { element, presses };
}

describe("hazard HZ-018 a home's handover on the phone, rendered", () => {
  it("says its state as an icon and a word before the items, and words each item with its flags", async () => {
    const view = await render(card("new_items").element);
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        "Cannot tell",
        "Latest handover on this phone",
        "Ada Example",
        "Fall, written in a care note",
        "31/10/2026 at 03:10",
        "Communication need",
        "New since you acknowledged",
        "Added late",
      ]),
    );
    expect(view.find("handover-loc-north-status")?.props.accessibilityLabel).toBe("Cannot tell");
  });

  it("acknowledges with one press, and asks again for new items", async () => {
    const first = card("none");
    const view = await render(first.element);
    expect(view.texts()).toContain("I have read this handover");
    await view.press("handover-loc-north-acknowledge");
    expect(first.presses).toEqual([1]);
    const again = await render(card("new_items").element);
    expect(again.texts()).toContain("I have read the new items");
  });

  it("hazard HZ-029 offers nothing more while an acknowledgement waits to upload, or once done", async () => {
    for (const state of ["waiting", "acknowledged"] as const) {
      const view = await render(card(state).element);
      expect(view.find("handover-loc-north-acknowledge")).toBeNull();
    }
    const waiting = await render(card("waiting").element);
    expect(waiting.texts()).toEqual(
      expect.arrayContaining([
        "Waiting to upload",
        "Your acknowledgement is saved on this phone and waiting to upload.",
      ]),
    );
  });

  it("shows a refusal to save as an alert", async () => {
    const { element } = card("none", [ITEM], { key: "mobile.handover.alreadyQueued" });
    const view = await render(element);
    await view.press("handover-loc-north-acknowledge");
    expect(view.find("handover-loc-north-problem")?.props.accessibilityRole).toBe("alert");
  });

  it("hazard HZ-028 says what an empty handover means, and offers no acknowledgement", async () => {
    const view = await render(card("nothing_to_acknowledge", []).element);
    expect(view.texts()).toContain("This handover holds no items you can see on this phone.");
    expect(view.find("handover-loc-north-acknowledge")).toBeNull();
  });
});

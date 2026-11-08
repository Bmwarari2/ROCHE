import { Button } from "@harbour/ui-native";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../test-support/render";

/**
 * A choice on the medicines record (slice 69) exposes its state to assistive technology and shows
 * it with a check icon, never by fill alone (WCAG 1.4.1, 4.1.2; accessibility review of slice 69).
 */
describe("a selectable button says whether it is chosen", () => {
  it.each([
    ["radio", true],
    ["radio", false],
    ["checkbox", true],
  ] as const)("%s, selected %s", async (kind, selected) => {
    const view = await render(
      createElement(Button, {
        label: "Refused",
        onPress: () => undefined,
        selection: { kind, selected },
        testID: "choice",
      }),
    );
    const button = view.find("choice");
    expect(button?.props.accessibilityRole).toBe(kind);
    expect(button?.props.accessibilityState).toMatchObject({ checked: selected, selected });
  });
});

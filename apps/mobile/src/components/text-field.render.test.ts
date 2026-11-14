import { nativeMetrics } from "@harbour/ui-native";
import { act, createElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../test-support/render";
import { TextField } from "./TextField";

/** The field's edge as drawn: its width and colour. */
function edge(view: Awaited<ReturnType<typeof render>>) {
  const style = view.find("field")?.props.style as ReadonlyArray<Record<string, unknown>>;
  const flat = Object.assign({}, ...style.flat());
  return { width: flat.borderWidth, colour: flat.borderColor };
}

async function focus(view: Awaited<ReturnType<typeof render>>, on: boolean) {
  const handler = view.find("field")?.props[on ? "onFocus" : "onBlur"];
  if (typeof handler !== "function") throw new Error("no focus handler");
  await act(async () => handler({}));
}

describe("TextField's edge (ADR-0138; redesign accessibility review H1 and M1)", () => {
  it("is outlined at rest, thicker in the brand colour when focused, and back when it leaves", async () => {
    const view = await render(createElement(TextField, { label: "Note", testID: "field" }));
    const rest = edge(view);
    expect(rest.width).toBe(nativeMetrics.outline);
    await focus(view, true);
    const focused = edge(view);
    expect(focused.width).toBe(nativeMetrics.focusOutline);
    expect(focused.colour).not.toBe(rest.colour);
    await focus(view, false);
    expect(edge(view)).toEqual(rest);
  });

  it("is red on an error, said in words too, and thicker still when focused so focus shows", async () => {
    const view = await render(
      createElement(TextField, { label: "Note", testID: "field", errorText: "Write a note" }),
    );
    const invalid = edge(view);
    expect(invalid.width).toBe(nativeMetrics.focusOutline);
    expect(view.texts()).toContain("Write a note");
    await focus(view, true);
    const both = edge(view);
    expect(both.width).toBeGreaterThan(invalid.width as number);
    expect(both.colour).toBe(invalid.colour);
  });

  it("still calls the screen's own focus handlers", async () => {
    const calls: string[] = [];
    const view = await render(
      createElement(TextField, {
        label: "Note",
        testID: "field",
        onFocus: () => calls.push("focus"),
        onBlur: () => calls.push("blur"),
      }),
    );
    await focus(view, true);
    await focus(view, false);
    expect(calls).toEqual(["focus", "blur"]);
  });
});

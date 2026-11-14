import { createElement, useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../test-support/render";
import { ChoiceGroup } from "./forms";

type Mood = "calm" | "anxious" | "upset";

function Harness() {
  const [value, setValue] = useState<Mood | null>("calm");
  return createElement(ChoiceGroup<Mood>, {
    label: "Mood",
    testID: "mood",
    value,
    onChange: setValue,
    options: [
      { value: "calm", label: "Calm" },
      { value: "anxious", label: "Anxious", detail: "Restless or worried" },
      { value: "upset", label: "Upset" },
    ],
  });
}

describe("ChoiceGroup as one grouped list (ADR-0138; iOS device check, 14/11/2026)", () => {
  it("marks the chosen row with a word as well as a mark, and says it is selected", async () => {
    const view = await render(createElement(Harness));
    expect(view.texts().filter((text) => text === "Selected")).toHaveLength(1);
    expect(view.find("mood-calm")?.props.accessibilityRole).toBe("radio");
    expect(view.find("mood-calm")?.props.accessibilityState).toEqual({
      selected: true,
      checked: true,
    });
    expect(view.find("mood-anxious")?.props.accessibilityLabel).toBe(
      "Anxious. Restless or worried",
    );
  });

  it("moves the mark and the word to the row pressed", async () => {
    const view = await render(createElement(Harness));
    await view.press("mood-upset");
    expect(view.find("mood-upset")?.props.accessibilityState).toEqual({
      selected: true,
      checked: true,
    });
    expect(view.find("mood-calm")?.props.accessibilityState).toEqual({
      selected: false,
      checked: false,
    });
    expect(view.texts().filter((text) => text === "Selected")).toHaveLength(1);
  });
});

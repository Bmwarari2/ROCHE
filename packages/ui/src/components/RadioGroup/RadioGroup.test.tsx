import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup } from "./RadioGroup";

const options = [
  { value: "left", label: "Left", description: "The person's own left" },
  { value: "right", label: "Right" },
  { value: "midline", label: "Midline" },
] as const;

describe("RadioGroup", () => {
  it("is a fieldset named by its legend, with a radio per option", () => {
    render(<RadioGroup legend="Which side?" name="side" options={options} />);
    const group = screen.getByRole("group", { name: "Which side?" });
    expect(group.tagName).toBe("FIELDSET");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    const left = screen.getByRole("radio", { name: "Left" });
    expect(left).toHaveAccessibleDescription("The person's own left");
    for (const radio of radios) expect(radio).toHaveAttribute("name", "side");
  });

  it("describes the group by its hint and error", () => {
    render(
      <RadioGroup
        legend="Which side?"
        name="side"
        options={options}
        hint="Choose in words."
        error="Choose the side in words"
      />,
    );
    expect(screen.getByRole("group", { name: "Which side?" })).toHaveAccessibleDescription(
      "Choose in words. Choose the side in words",
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-invalid", "true");
    }
  });

  it("gives the first choice the id an error summary links to", () => {
    const { rerender } = render(
      <RadioGroup legend="Which side?" name="side" options={options} id="side-field" />,
    );
    expect(screen.getByRole("radio", { name: "Left" })).toHaveAttribute("id", "side-field");
    expect(screen.getByRole("radio", { name: "Right" })).not.toHaveAttribute("id");
    rerender(<RadioGroup legend="Which side?" name="side" options={options} />);
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toHaveAttribute("aria-invalid");
    }
  });

  it("selects by clicking anywhere on the card and reports the value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup
        legend="Which side?"
        name="side"
        options={options}
        onValueChange={onValueChange}
      />,
    );
    await user.click(screen.getByText("The person's own left"));
    expect(screen.getByRole("radio", { name: "Left" })).toBeChecked();
    expect(onValueChange).toHaveBeenLastCalledWith("left");
  });

  it("moves the choice with the arrow keys like native radios", async () => {
    const user = userEvent.setup();
    render(<RadioGroup legend="Which side?" name="side" options={options} defaultValue="left" />);
    await user.tab();
    expect(screen.getByRole("radio", { name: "Left" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Right" })).toBeChecked();
  });

  it("follows a controlled value, including nothing chosen", async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [value, setValue] = useState<"left" | "right" | "midline" | null>(null);
      return (
        <>
          <RadioGroup
            legend="Which side?"
            name="side"
            options={options}
            value={value}
            onValueChange={setValue}
          />
          <output>{value ?? "none"}</output>
        </>
      );
    }
    render(<Controlled />);
    expect(screen.getAllByRole("radio").some((radio) => (radio as HTMLInputElement).checked)).toBe(
      false,
    );
    await user.click(screen.getByRole("radio", { name: "Midline" }));
    expect(screen.getByText("midline")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Midline" })).toBeChecked();
  });
});

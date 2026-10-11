import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

type User = ReturnType<typeof userEvent.setup>;

/**
 * Presses and then releases a key with a pause in between, like a person does. Radix moves focus
 * in a timeout after keydown and selects only while the arrow key is still held.
 */
async function press(user: User, key: string) {
  await user.keyboard(`{${key}>}`);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await user.keyboard(`{/${key}}`);
}

const options = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

describe("SegmentedControl", () => {
  it("has radio-group semantics with a name", () => {
    render(<SegmentedControl label="Rota view" options={options} defaultValue="week" />);
    const group = screen.getByRole("radiogroup", { name: "Rota view" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Day", "Week", "Month"]);
    expect(within(group).getByRole("radio", { name: "Week" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("moves selection with the arrow keys and wraps around", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        label="Rota view"
        options={options}
        defaultValue="week"
        onValueChange={onValueChange}
      />,
    );
    const week = screen.getByRole("radio", { name: "Week" });
    const month = screen.getByRole("radio", { name: "Month" });
    const day = screen.getByRole("radio", { name: "Day" });

    // Tab lands on the selected option only.
    await user.tab();
    expect(week).toHaveFocus();

    await press(user, "ArrowRight");
    expect(month).toHaveFocus();
    expect(month).toHaveAttribute("aria-checked", "true");
    expect(onValueChange).toHaveBeenLastCalledWith("month");

    await press(user, "ArrowRight");
    expect(day).toHaveFocus();
    expect(day).toHaveAttribute("aria-checked", "true");
    expect(onValueChange).toHaveBeenLastCalledWith("day");

    await press(user, "ArrowLeft");
    expect(month).toHaveFocus();
    expect(onValueChange).toHaveBeenLastCalledWith("month");

    // Tab leaves the group in one step.
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("keeps a hidden label as the accessible name", () => {
    render(<SegmentedControl label="Row density" hideLabel options={options} />);
    expect(screen.getByRole("radiogroup", { name: "Row density" })).toBeInTheDocument();
  });
});

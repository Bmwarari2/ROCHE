import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

describe("Toggle", () => {
  it("is a switch named by its visible label", () => {
    render(<Toggle label="Email me when a care note is corrected" />);
    const toggle = screen.getByRole("switch", { name: "Email me when a care note is corrected" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Email me when a care note is corrected")).toBeVisible();
  });

  it("toggles with Space and Enter from the keyboard", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Toggle label="Large print records" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole("switch", { name: "Large print records" });

    await user.tab();
    expect(toggle).toHaveFocus();

    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("toggles when the label is clicked", async () => {
    const user = userEvent.setup();
    render(<Toggle label="Show the family portal" />);
    await user.click(screen.getByText("Show the family portal"));
    expect(screen.getByRole("switch", { name: "Show the family portal" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("links the description", () => {
    render(<Toggle label="Show the family portal" description="Family members can see photos." />);
    expect(screen.getByRole("switch")).toHaveAccessibleDescription(
      "Family members can see photos.",
    );
  });

  it("does not change when disabled", async () => {
    const user = userEvent.setup();
    render(<Toggle label="Large print records" disabled defaultChecked />);
    const toggle = screen.getByRole("switch");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

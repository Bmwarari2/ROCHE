import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  it("is a checkbox named by its label, ticked by clicking the label", async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Skin checked" name="skinChecked" />);
    const box = screen.getByRole("checkbox", { name: "Skin checked" });
    expect(box).not.toBeChecked();
    await user.click(screen.getByText("Skin checked"));
    expect(box).toBeChecked();
  });

  it("makes the whole row one label, with the hint and error outside the name", async () => {
    const user = userEvent.setup();
    render(<Checkbox label="Refused" hint="Shown at handover." name="refused" />);
    const box = screen.getByRole("checkbox", { name: "Refused" });
    const row = box.closest("label");
    expect(row).toHaveClass("hb-check__target");
    expect(row).toContainElement(screen.getByText("Refused"));
    expect(row).not.toContainElement(screen.getByText("Shown at handover."));
    if (row) await user.click(row);
    expect(box).toBeChecked();
  });

  it("is described by its hint and error", () => {
    render(<Checkbox label="Refused" hint="Shown at handover." error="Tick the box to confirm" />);
    const box = screen.getByRole("checkbox", { name: "Refused" });
    expect(box).toHaveAccessibleDescription("Shown at handover. Tick the box to confirm");
    expect(box).toHaveAttribute("aria-invalid", "true");
  });
});

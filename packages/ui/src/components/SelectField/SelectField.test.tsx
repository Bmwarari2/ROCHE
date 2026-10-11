import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SelectField } from "./SelectField";

describe("SelectField", () => {
  it("is a labelled list box with an empty first choice", async () => {
    const user = userEvent.setup();
    render(
      <SelectField
        label="Meal"
        emptyOption="Choose a meal"
        options={[
          { value: "breakfast", label: "Breakfast" },
          { value: "lunch", label: "Lunch" },
        ]}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Meal" });
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Choose a meal", "Breakfast", "Lunch"]);
    expect(select).toHaveValue("");
    await user.selectOptions(select, "lunch");
    expect(select).toHaveValue("lunch");
  });

  it("groups options and is described by its hint and error", () => {
    render(
      <SelectField
        label="Body area"
        hint="As marked on the drawing."
        error="Choose a body area"
        groups={[{ label: "Knee", options: [{ value: "knee:left", label: "Knee, left" }] }]}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Body area" });
    expect(select).toHaveAccessibleDescription("As marked on the drawing. Choose a body area");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(within(select).getByRole("group", { name: "Knee" })).toBeInTheDocument();
  });
});

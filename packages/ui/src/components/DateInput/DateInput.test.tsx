import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { WallClock } from "../../lib/zoned-time";
import { DateInput } from "./DateInput";
import { DateTimeInput } from "./DateTimeInput";

/** The app's rule, as a stand-in: 01:00 to 01:59 on 25/10/2026 happened twice. */
const repeated = (wall: WallClock) =>
  wall.year === 2026 && wall.month === 10 && wall.day === 25 && wall.hour === 1
    ? { first: "BST", second: "GMT" }
    : null;

describe("DateInput", () => {
  it("is a fieldset of day, month and year boxes named by the legend", () => {
    render(
      <DateInput legend="Date of the assessment" name="assessedOn" defaultValue="2026-03-05" />,
    );
    const group = screen.getByRole("group", { name: "Date of the assessment" });
    const boxes = within(group).getAllByRole("textbox");
    expect(boxes.map((box) => box.getAttribute("name"))).toEqual([
      "assessedOn-day",
      "assessedOn-month",
      "assessedOn-year",
    ]);
    expect(screen.getByRole("textbox", { name: "Day" })).toHaveValue("05");
    expect(screen.getByRole("textbox", { name: "Month" })).toHaveValue("03");
    expect(screen.getByRole("textbox", { name: "Year" })).toHaveValue("2026");
    for (const box of boxes) expect(box).toHaveAttribute("inputmode", "numeric");
  });

  it("describes the group by its hint and error and marks only the boxes in error", () => {
    render(
      <DateInput
        legend="Review date"
        name="reviewDueOn"
        id="review"
        hint="For example, 27 3 2026"
        error="The review date must include a month"
        errorParts={["month"]}
      />,
    );
    expect(screen.getByRole("group", { name: "Review date" })).toHaveAccessibleDescription(
      "For example, 27 3 2026 The review date must include a month",
    );
    expect(screen.getByRole("textbox", { name: "Day" })).toHaveAttribute("id", "review");
    const month = screen.getByRole("textbox", { name: "Month" });
    expect(month).toHaveAttribute("aria-invalid", "true");
    expect(month).toHaveAccessibleDescription("The review date must include a month");
    expect(screen.getByRole("textbox", { name: "Day" })).not.toHaveAttribute("aria-invalid");
  });
});

describe("DateTimeInput", () => {
  it("adds hour and minute boxes for a 24-hour time", () => {
    render(
      <DateTimeInput
        legend="When did it happen?"
        name="occurredAt"
        defaultValue={{ day: "11", month: "10", year: "2026", hour: "14", minute: "05" }}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Hour" })).toHaveValue("14");
    expect(screen.getByRole("textbox", { name: "Minute" })).toHaveAttribute(
      "name",
      "occurredAt-minute",
    );
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("hazard HZ-009 hazard HZ-017 asks which time was meant only when the app's rule says it happened twice", async () => {
    const user = userEvent.setup();
    render(
      <DateTimeInput
        legend="When did it happen?"
        name="occurredAt"
        repeated={repeated}
        defaultValue={{ day: "25", month: "10", year: "2026", hour: "00", minute: "30" }}
      />,
    );
    expect(screen.queryByRole("radio")).toBeNull();
    const hour = screen.getByRole("textbox", { name: "Hour" });
    await user.clear(hour);
    await user.type(hour, "01");
    const question = screen.getByRole("group", {
      name: "The clocks went back on 25/10/2026, so 01:30 happened twice. Which 01:30 was it?",
    });
    const first = within(question).getByRole("radio", {
      name: "01:30 BST, before the clocks went back",
    });
    const second = within(question).getByRole("radio", {
      name: "01:30 GMT, after the clocks went back",
    });
    expect(first).toBeRequired();
    expect(first).not.toBeChecked();
    expect(second).toHaveAttribute("name", "occurredAt-fold");
    await user.click(second);
    expect(second).toBeChecked();
    await user.clear(hour);
    await user.type(hour, "02");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("puts an error about the repeated time on that question", () => {
    render(
      <DateTimeInput
        legend="When did it happen?"
        name="occurredAt"
        error="Choose which 01:30 it was"
        errorParts={["fold"]}
        repeated={repeated}
        defaultValue={{ day: "25", month: "10", year: "2026", hour: "01", minute: "30" }}
      />,
    );
    expect(screen.getByRole("group", { name: "When did it happen?" })).not.toHaveAttribute(
      "aria-describedby",
    );
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-invalid", "true");
    }
    expect(screen.getByText("Choose which 01:30 it was")).toBeVisible();
  });
});

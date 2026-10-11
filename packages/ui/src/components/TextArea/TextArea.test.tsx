import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHARACTER_COUNT_ANNOUNCE_DELAY, defaultCharacterCount, TextArea } from "./TextArea";

afterEach(() => {
  vi.useRealTimers();
});

describe("defaultCharacterCount", () => {
  it.each([
    [1000, "You have 1,000 characters remaining"],
    [20, "You have 20 characters remaining"],
    [1, "You have 1 character remaining"],
    [0, "You have 0 characters remaining"],
    [-1, "You have 1 character too many"],
    [-12, "You have 12 characters too many"],
  ])("%i remaining reads %s", (remaining, expected) => {
    expect(defaultCharacterCount(remaining)).toBe(expected);
  });
});

describe("TextArea", () => {
  it("is a multi-line text box named by its visible label", () => {
    render(<TextArea label="Handover note" />);
    const field = screen.getByRole("textbox", { name: "Handover note" });
    expect(field.tagName).toBe("TEXTAREA");
    expect(field).toHaveAttribute("rows", "5");
    expect(field).not.toHaveAttribute("aria-describedby");
    expect(field).not.toHaveAttribute("aria-invalid");
  });

  it("is described by its hint, error and count, in that order", () => {
    render(
      <TextArea
        label="Reason"
        hint="At least 20 characters."
        error="Explain why you need this record in 20 characters or more."
        maxLength={100}
        defaultValue="Covering"
      />,
    );
    const field = screen.getByRole("textbox", { name: "Reason" });
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(
      "At least 20 characters. Explain why you need this record in 20 characters or more. You have 92 characters remaining",
    );
    expect(field.getAttribute("aria-describedby")?.split(" ")).toHaveLength(3);
  });

  it("does not cut text off at the maximum, and says how many characters are too many", async () => {
    const user = userEvent.setup();
    render(<TextArea label="Summary" maxLength={5} />);
    const field = screen.getByRole("textbox", { name: "Summary" });
    expect(field).not.toHaveAttribute("maxlength");
    expect(screen.getByText("You have 5 characters remaining")).toBeInTheDocument();

    await user.type(field, "Ada");
    expect(screen.getByText("You have 2 characters remaining")).not.toHaveAttribute("data-over");

    await user.type(field, " slept");
    expect(field).toHaveValue("Ada slept");
    const count = screen.getByText("You have 4 characters too many");
    expect(count).toHaveAttribute("data-over", "true");
    expect(count).toHaveClass("hb-field__count--over");
  });

  it("announces the count politely once typing pauses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(<TextArea label="Reason" maxLength={50} />);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("");

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Covering");
    expect(live).toHaveTextContent("");

    await act(async () => {
      vi.advanceTimersByTime(CHARACTER_COUNT_ANNOUNCE_DELAY);
    });
    expect(live).toHaveTextContent("You have 42 characters remaining");
  });

  it("uses the app's words for the count", () => {
    render(
      <TextArea
        label="Rheswm"
        maxLength={10}
        defaultValue="abc"
        formatCount={(remaining, max) => `${remaining} o ${max} ar ôl`}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Rheswm" })).toHaveAccessibleDescription(
      "7 o 10 ar ôl",
    );
  });

  it("counts a controlled value and still calls onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Controlled() {
      const [text, setText] = useState("Ada");
      return (
        <TextArea
          label="Note"
          maxLength={10}
          value={text}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            setText(event.currentTarget.value);
          }}
        />
      );
    }
    render(<Controlled />);
    expect(screen.getByText("You have 7 characters remaining")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Note" }), "!");
    expect(onChange).toHaveBeenLastCalledWith("Ada!");
    expect(screen.getByText("You have 6 characters remaining")).toBeInTheDocument();
  });

  it("passes the ref and native attributes to the text area", () => {
    let element: HTMLTextAreaElement | null = null;
    render(
      <TextArea
        label="Reason"
        name="justification"
        required
        rows={3}
        ref={(node) => {
          element = node;
        }}
      />,
    );
    const field = screen.getByRole("textbox", { name: "Reason" });
    expect(element).toBe(field);
    expect(field).toHaveAttribute("name", "justification");
    expect(field).toBeRequired();
    expect(field).toHaveAttribute("rows", "3");
  });
});

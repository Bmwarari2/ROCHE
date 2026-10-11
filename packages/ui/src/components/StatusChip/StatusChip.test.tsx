import { render, screen } from "@testing-library/react";
import { PencilLine } from "lucide-react";
import { describe, expect, it } from "vitest";
import { clinicalStatus } from "../../tokens/tokens";
import { StatusChip, type StatusChipStatus } from "./StatusChip";

function visibleText(element: HTMLElement): string {
  // Text inside visually hidden helpers would not be seen; a chip must not rely on it.
  const clone = element.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll(".hb-visually-hidden, [aria-hidden='true']")) {
    hidden.remove();
  }
  return clone.textContent?.trim() ?? "";
}

const cases: Array<[StatusChipStatus, string | undefined, string]> = [
  ["overdue", undefined, clinicalStatus.overdue.label],
  ["due", undefined, clinicalStatus.due.label],
  ["done", undefined, clinicalStatus.done.label],
  ["notApplicable", undefined, clinicalStatus.notApplicable.label],
  ["due", "Due at 14:00", "Due at 14:00"],
  ["info", "New", "New"],
  ["neutral", "Draft", "Draft"],
];

describe("StatusChip", () => {
  it.each(cases)("%s shows a visible word and an icon (label %s)", (status, label, expected) => {
    const { container } = render(
      label === undefined ? (
        <StatusChip status={status as keyof typeof clinicalStatus} />
      ) : (
        <StatusChip status={status} label={label} />
      ),
    );
    const chip = container.firstElementChild as HTMLElement;
    expect(visibleText(chip)).toBe(expected);
    expect(screen.getByText(expected)).toBeVisible();
    const icon = chip.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to the default word when given an empty label", () => {
    const { container } = render(<StatusChip status="overdue" label="   " />);
    expect(visibleText(container.firstElementChild as HTMLElement)).toBe("Overdue");
  });

  it("never renders without text, whatever the status", () => {
    const statuses: StatusChipStatus[] = ["overdue", "due", "done", "notApplicable"];
    for (const status of statuses) {
      const { container, unmount } = render(
        <StatusChip status={status as keyof typeof clinicalStatus} />,
      );
      expect(visibleText(container.firstElementChild as HTMLElement).length).toBeGreaterThan(0);
      unmount();
    }
    for (const status of ["info", "neutral"] as const) {
      const { container, unmount } = render(<StatusChip status={status} label="" />);
      expect(visibleText(container.firstElementChild as HTMLElement).length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("takes its own icon for states with their own symbol, still beside the word", () => {
    const { container } = render(
      <StatusChip status="info" label="Draft, not in use" icon={PencilLine} />,
    );
    const chip = container.firstElementChild as HTMLElement;
    expect(visibleText(chip)).toBe("Draft, not in use");
    const icon = chip.querySelector("svg");
    expect(icon).toHaveClass("lucide-pencil-line");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});

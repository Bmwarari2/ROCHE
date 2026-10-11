import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Timeline, type TimelineEntry } from "./Timeline";

const entries: TimelineEntry[] = [
  {
    id: "n-2",
    author: "Dina Testcase",
    authorRole: "Carer",
    time: "2026-10-03T09:40:00Z",
    body: "Ada had a shower with help from one carer.",
    correction: {
      body: "Ada had a shower with help from two carers.",
      author: "Ben Sample",
      time: "2026-10-03T10:12:00Z",
      reason: "Wrong number of carers recorded",
    },
  },
  {
    id: "n-1",
    author: "Gita Mockup",
    time: "2026-01-15T05:30:00Z",
    timeLabel: "15/01/2026 05:30",
    body: "Settled night.",
  },
];

describe("Timeline", () => {
  it("lists entries with author and time", () => {
    render(<Timeline entries={entries} label="Care notes" />);
    const list = screen.getByRole("list", { name: "Care notes" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const plain = items[1] as HTMLElement;
    expect(plain).toHaveTextContent("Gita Mockup");
    expect(within(plain).getByText("15/01/2026 05:30")).toHaveAttribute(
      "datetime",
      "2026-01-15T05:30:00Z",
    );
    expect(plain.querySelector("del")).toBeNull();
  });

  it("renders a correction as a single-line strike-through with the correction, time and author", () => {
    render(<Timeline entries={entries} label="Care notes" />);
    const corrected = screen.getAllByRole("listitem")[0] as HTMLElement;

    const original = corrected.querySelector("del");
    expect(original).not.toBeNull();
    expect(original).toHaveTextContent("Ada had a shower with help from one carer.");
    expect(original).toHaveClass("hb-timeline__body--struck");

    const correction = corrected.querySelector("ins");
    expect(correction).toHaveTextContent("Ada had a shower with help from two carers.");

    // UK time, dd/mm/yyyy and 24-hour clock: 09:40 UTC is 10:40 BST.
    expect(within(corrected).getByText("03/10/2026 10:40")).toHaveAttribute(
      "datetime",
      "2026-10-03T09:40:00Z",
    );
    const meta = within(corrected).getByText(/Corrected by/);
    expect(meta).toHaveTextContent("Corrected by Ben Sample on 03/10/2026 11:12");
    expect(within(corrected).getByText("Reason: Wrong number of carers recorded")).toBeVisible();
    expect(within(corrected).getByText("Correction")).toBeVisible();
    // The original author stays on the entry.
    expect(corrected).toHaveTextContent("Dina Testcase");
  });
});

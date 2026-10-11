import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskDetails } from "./TaskDetails";

/** The words a reader hears, without markup. */
const words = (html: string) => {
  let text = "";
  let inTag = false;
  for (const char of html) {
    if (char === "<") inTag = true;
    else if (char === ">") {
      inTag = false;
      text += " ";
    } else if (!inTag) text += char;
  }
  return text.split(" ").filter(Boolean).join(" ");
};

const render = (details: Parameters<typeof TaskDetails>[0]["details"]) =>
  renderToStaticMarkup(createElement(TaskDetails, { details }));

describe("TaskDetails: what a review task lists (C8)", () => {
  it("hazard HZ-003 lists the missed rounds by kind and UK time, and which one is caught up", () => {
    const text = words(
      render({
        missedTasks: [
          {
            taskId: "0193a000-0000-7000-8000-00000000b001",
            kind: "care.reposition",
            dueAt: "2026-10-11T09:00:00.000Z",
            reopened: false,
          },
          {
            taskId: "0193a000-0000-7000-8000-00000000b002",
            kind: "care.reposition",
            dueAt: "2026-10-11T11:00:00.000Z",
            reopened: true,
          },
        ],
        missedTasksOmitted: 3,
      }),
    );
    expect(text).toContain("Reposition, due 11/10/2026 10:00: missed");
    expect(text).toContain("Reposition, due 11/10/2026 12:00: caught up now");
    expect(text).toContain("And 3 more not listed.");
  });

  it("hazards HZ-004 and HZ-006 lists the entries to review by kind, time and outcome, with opaque ids only", () => {
    const text = words(
      render({
        entries: [
          {
            kind: "observation",
            clientId: "0193a000-0000-7000-8000-00000000c001",
            occurredAt: "2026-10-11T08:05:00.000Z",
            outcome: "medicines_conflict",
            deviceId: "device-7",
          },
        ],
      }),
    );
    expect(text).toContain("Chart entry for 11/10/2026 09:05.");
    expect(text).toContain(
      "Tell the nurse in charge now. Only the person who gave a medicine records it.",
    );
    expect(text).toContain("Entry 0193a000-0000-7000-8000-00000000c001, device device-7");
  });

  it("shows nothing when there is nothing to list", () => {
    expect(render(null)).toBe("");
    expect(render({})).toBe("");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntryLifecycleBadges, TaskEvidenceBadge } from "./LifecycleBadges";

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

type Outcome =
  | "completed"
  | "task_cancelled"
  | "task_already_closed"
  | "not_linked"
  | "medicines_conflict"
  | null;
const render = (recordedAfterExit: boolean, taskOutcome: Outcome) =>
  renderToStaticMarkup(
    createElement(EntryLifecycleBadges, { entry: { recordedAfterExit, taskOutcome } }),
  );

describe("EntryLifecycleBadges", () => {
  it.each<[string, boolean, Outcome, string]>([
    [
      "hazard HZ-006 an entry recorded offline for a round a move cancelled",
      true,
      "task_cancelled",
      "Recorded after the person left Its round had been cancelled",
    ],
    [
      "hazard HZ-004 an entry for a round already recorded, for review",
      false,
      "task_already_closed",
      "Round already recorded: for review",
    ],
    [
      "hazard HZ-004 an entry its author could not link to the round, for review",
      false,
      "not_linked",
      "Not linked to its round: for review",
    ],
    ["hazard HZ-006 an entry accepted after an exit", true, null, "Recorded after the person left"],
    [
      "hazard HZ-004 a medicines entry that could not complete its task tells the user to act now",
      false,
      "medicines_conflict",
      "Tell the nurse in charge now. Only the person who gave a medicine records it.",
    ],
  ])("%s says so in words and an icon", (_label, after, outcome, expected) => {
    const html = render(after, outcome);
    expect(words(html)).toBe(expected);
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows nothing for an entry that completed its round on time", () => {
    expect(render(false, "completed")).toBe("");
    expect(render(false, null)).toBe("");
  });
});

describe("TaskEvidenceBadge", () => {
  it("hazard HZ-006 says a cancelled task's evidence arrived after it was cancelled", () => {
    const html = renderToStaticMarkup(
      createElement(TaskEvidenceBadge, { task: { evidenceAfterClose: true } }),
    );
    expect(words(html)).toBe("Recorded after it was cancelled");
    expect(html).toContain("<svg");
    expect(
      renderToStaticMarkup(
        createElement(TaskEvidenceBadge, { task: { evidenceAfterClose: false } }),
      ),
    ).toBe("");
  });

  it("hazard HZ-003 tells a caught-up round and one done before it was stopped apart by their flags", () => {
    const render = (task: {
      evidenceAfterClose: boolean;
      catchUp?: boolean;
      restoredDone?: boolean;
    }) => words(renderToStaticMarkup(createElement(TaskEvidenceBadge, { task })));
    expect(render({ evidenceAfterClose: false, catchUp: true })).toBe(
      "Caught up after a late return",
    );
    expect(render({ evidenceAfterClose: false, restoredDone: true })).toBe(
      "Done before it was stopped",
    );
  });
});

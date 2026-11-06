import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../test-support/render";
import { courseItems } from "../training/view";
import { TrainingCourseCard } from "./TrainingCourseCard";

/** A course in the training list, rendered (mobile slice 72). Invented ids only. */

const COURSE = "0199d000-0000-7000-8000-000000000c01";

function card(answer: string | null = null, downloaded = false) {
  const pressed: string[] = [];
  const [item] = courseItems({
    online: [{ id: COURSE, title: "Fire safety", status: "active" }],
    downloaded: downloaded
      ? [
          {
            manifest: {
              courseId: COURSE,
              title: "Fire safety",
              standard: "scorm_1_2",
              launchPath: "index.html",
              launchQuery: "",
              packageSha256: "a".repeat(64),
              files: [{ path: "index.html", size: 12 * 1024 * 1024 }],
              totalBytes: 12 * 1024 * 1024,
            },
            downloadedAt: "2026-11-06T09:00:00.000Z",
          },
        ]
      : [],
    attempts: [],
    waitingAttemptIds: new Set(),
    downloading: null,
  });
  if (!item) throw new Error("no item");
  const element = createElement(TrainingCourseCard, {
    item,
    answer,
    onDownload: () => pressed.push("download"),
    onOpen: () => pressed.push("open"),
    onRemove: () => pressed.push("remove"),
  });
  return { element, pressed };
}

describe("a training course, rendered", () => {
  it("says it is not on the phone and offers the download, named for the course", async () => {
    const { element, pressed } = card();
    const view = await render(element);
    expect(view.texts()).toEqual(expect.arrayContaining(["Fire safety", "Not on this phone"]));
    expect(view.find(`course-${COURSE}-open`)).toBeNull();
    await view.press(`course-${COURSE}-download`);
    expect(pressed).toEqual(["download"]);
  });

  it("says it is on the phone, with its size, and offers to open or remove it", async () => {
    const { element, pressed } = card(null, true);
    const view = await render(element);
    expect(view.texts()).toEqual(expect.arrayContaining(["On this phone", "Size: 12 MB"]));
    expect(view.find(`course-${COURSE}-open`)?.props.accessibilityLabel).toBe("Open Fire safety");
    await view.press(`course-${COURSE}-open`);
    await view.press(`course-${COURSE}-remove`);
    expect(pressed).toEqual(["open", "remove"]);
  });

  it("says in words why a download did not happen", async () => {
    const words =
      "This course needs 250 MB free on this phone, with room to spare, and the phone has 120 MB. Free some space, then try again.";
    const view = await render(card(words).element);
    expect(view.texts()).toContain(words);
  });
});

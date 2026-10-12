import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EntryBadges } from "./EntryBadges";

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

type Entry = Parameters<typeof EntryBadges>[0]["entry"];
const render = (entry: Entry) => renderToStaticMarkup(createElement(EntryBadges, { entry }));

describe("EntryBadges", () => {
  it("hazard HZ-017 says an entry was written late, with when it was recorded, in words and an icon", () => {
    const html = render({
      lateEntry: true,
      clockDrift: false,
      recordedAt: "2026-10-11T13:05:00.000Z",
    });
    expect(words(html)).toBe("Late entry Recorded 11/10/2026 14:05");
    expect(html).toContain("<svg");
  });

  it("hazard HZ-010 says when the device clock differed from the server's", () => {
    expect(
      words(render({ lateEntry: false, clockDrift: true, recordedAt: "2026-10-11T13:05:00Z" })),
    ).toBe("Device clock differed");
  });

  it("shows nothing for an entry written on time on a device with the right clock", () => {
    expect(
      render({ lateEntry: false, clockDrift: false, recordedAt: "2026-10-11T13:05:00Z" }),
    ).toBe("");
  });

  it("hazards HZ-004 and HZ-006 show what an exit or a closed round did to the entry, beside the other flags", () => {
    const text = words(
      render({
        lateEntry: true,
        clockDrift: false,
        recordedAt: "2026-10-11T13:05:00.000Z",
        recordedAfterExit: true,
        taskOutcome: "not_linked",
      }),
    );
    expect(text).toBe(
      "Late entry Recorded 11/10/2026 14:05 Recorded after the person left Not linked to its round: for review",
    );
  });

  it.each([
    ["uploaded_after_deletion", "Sent after its device deleted it: check for a duplicate"],
    ["deleted_after_upload", "Deleted on its device after it was saved: check for a duplicate"],
  ] as const)(
    "hazard HZ-040 says an entry its device recorded deleting (%s) may be a duplicate, in words and an icon",
    (deviceDeletion, wording) => {
      const html = render({
        lateEntry: false,
        clockDrift: false,
        recordedAt: "2026-10-11T13:05:00Z",
        deviceDeletion,
      });
      expect(words(html)).toBe(wording);
      expect(html).toContain(`data-device-deletion="${deviceDeletion}"`);
      expect(html).toContain("<svg");
    },
  );
});

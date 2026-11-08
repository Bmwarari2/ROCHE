import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { clearSavedNotice, savedNoticeFor, savedNoticeWords, setSavedNotice } from "./saved-notice";

const t = createTranslator("en-GB");
/** Invented ids and an invented person. */
const ADA = "0199d000-0000-7000-8000-000000000a01";
const BEN = "0199d000-0000-7000-8000-000000000b01";

describe("hazard HZ-001 the save confirmation names the person and what was saved", () => {
  it.each([
    [
      "care_note",
      false,
      "Note saved for Ada Example, on this device. It uploads when you are online.",
    ],
    [
      "care_note",
      true,
      "Corrected note saved for Ada Example, on this device. It uploads when you are online.",
    ],
    [
      "observation",
      false,
      "Chart entry saved for Ada Example, on this device. It uploads when you are online.",
    ],
    [
      "body_map_mark",
      false,
      "Body map mark saved for Ada Example, on this device. It uploads when you are online.",
    ],
    [
      "body_map_mark",
      true,
      "Corrected body map mark saved for Ada Example, on this device. It uploads when you are online.",
    ],
  ] as const)("%s (corrected %s)", (table, corrected, words) => {
    expect(savedNoticeWords({ personName: "Ada Example", table, corrected }, t, false)).toBe(words);
  });

  it("says demo mode in demo mode", () => {
    expect(
      savedNoticeWords(
        { personName: "Ada Example", table: "care_note", corrected: false },
        t,
        true,
      ),
    ).toBe("Note saved for Ada Example, on this device (demo mode).");
  });

  it("is shown only on that person's record, until cleared", () => {
    setSavedNotice({
      personId: ADA,
      personName: "Ada Example",
      table: "care_note",
      corrected: false,
      at: 1,
    });
    expect(savedNoticeFor(ADA)?.personName).toBe("Ada Example");
    expect(savedNoticeFor(BEN)).toBeNull();
    clearSavedNotice();
    expect(savedNoticeFor(ADA)).toBeNull();
  });
});

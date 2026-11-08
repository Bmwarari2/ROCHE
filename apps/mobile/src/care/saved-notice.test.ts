import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  clearNoticeForOthers,
  clearSavedNotice,
  noticeIfFor,
  SAVED_NOTICE_MS,
  type SavedNotice,
  savedNoticeFor,
  savedNoticeWords,
  setSavedNotice,
} from "./saved-notice";

const t = createTranslator("en-GB");
/** Invented ids and an invented person. */
const ADA = "0199d000-0000-7000-8000-000000000a01";
const BEN = "0199d000-0000-7000-8000-000000000b01";
/** 14:05 in London on a winter day. */
const AT = Date.parse("2026-11-08T14:05:00Z");
const tail = ", on this device. Whether it has been sent shows on the entry below.";

const notice = (overrides: Partial<SavedNotice> = {}): SavedNotice => ({
  personId: ADA,
  personName: "Ada Example",
  table: "care_note",
  corrected: false,
  at: AT,
  ...overrides,
});

describe("hazard HZ-001 the save confirmation names the person, what was saved and when", () => {
  it.each([
    ["care_note", false, "Note"],
    ["care_note", true, "Corrected note"],
    ["observation", false, "Chart entry"],
    ["observation", true, "Corrected chart entry"],
    ["body_map_mark", false, "Body map mark"],
    ["body_map_mark", true, "Corrected body map mark"],
  ] as const)("%s (corrected %s) is one whole sentence", (table, corrected, what) => {
    expect(savedNoticeWords(notice({ table, corrected }), t, false)).toBe(
      `${what} saved for Ada Example at 14:05${tail}`,
    );
  });

  it("says demo mode in demo mode, and never claims an upload", () => {
    const words = savedNoticeWords(notice(), t, true);
    expect(words).toBe("Note saved for Ada Example at 14:05, on this device (demo mode).");
    expect(savedNoticeWords(notice(), t, false)).not.toMatch(/uploads|uploaded/);
  });

  it.each([
    ["this person's record, just saved", ADA, AT + 1000, true],
    ["another person's record", BEN, AT + 1000, false],
    ["this person's record once 15 minutes have passed", ADA, AT + SAVED_NOTICE_MS, false],
    ["a time before the save (a clock moved back)", ADA, AT - 1000, false],
  ])("on %s: shown %s", (_label, personId, now, shown) => {
    expect(noticeIfFor(notice(), personId, now) !== null).toBe(shown);
  });

  it("is dropped when another person's record opens, kept when the same one does", () => {
    setSavedNotice(notice({ at: Date.now() }));
    clearNoticeForOthers(ADA);
    expect(savedNoticeFor(ADA)?.personName).toBe("Ada Example");
    clearNoticeForOthers(BEN);
    expect(savedNoticeFor(ADA)).toBeNull();
    setSavedNotice(notice({ at: Date.now() }));
    clearSavedNotice();
    expect(savedNoticeFor(ADA)).toBeNull();
  });
});

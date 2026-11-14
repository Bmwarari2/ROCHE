import { AccessibilityInfo, AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOUNCE_FALLBACK_MS,
  announceAfterReturn,
  announceReturned,
  resetPendingAnnouncement,
  setAnnouncementsAllowed,
} from "./announce-after-return";

/**
 * HZ-001 and accessibility review H1 (14/11/2026): the save confirmation is said once the record or
 * list the form returns to is on screen, queued behind what VoiceOver is saying, never while
 * locked, and said again once on iOS if VoiceOver reports it was cut off.
 */
const stub = AccessibilityInfo as unknown as {
  announced: string[];
  announcedWith: Array<{ text: string; options: { queue?: boolean } }>;
  listeners: unknown[];
  emit(event: string, payload: unknown): void;
};

const appState = AppState as unknown as { listeners: unknown[]; emit(next: string): void };

const WORDS = "Note saved for Ada Example at 14:05, on this device.";

beforeEach(() => {
  vi.useFakeTimers();
  stub.announced.length = 0;
  stub.announcedWith.length = 0;
  stub.listeners.length = 0;
  appState.listeners.length = 0;
  resetPendingAnnouncement();
  setAnnouncementsAllowed(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the save confirmation after returning", () => {
  it("is not said while the screen changes, and is said once, queued, when it has appeared", () => {
    announceAfterReturn(WORDS);
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS - 1);
    expect(stub.announced).toEqual([]);
    announceReturned();
    expect(stub.announcedWith).toEqual([{ text: WORDS, options: { queue: true } }]);
    announceReturned();
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS * 2);
    expect(stub.announced).toEqual([WORDS]);
  });

  it("is said by the fallback when no transition event comes", () => {
    announceAfterReturn(WORDS);
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS);
    expect(stub.announcedWith).toEqual([{ text: WORDS, options: { queue: true } }]);
  });

  it("is never said while the app is locked, and is dropped rather than said later", () => {
    setAnnouncementsAllowed(false);
    announceAfterReturn(WORDS);
    announceReturned();
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS * 2);
    expect(stub.announced).toEqual([]);
  });

  it("is dropped when the phone locks after the form has gone, before the fallback fires", () => {
    announceAfterReturn(WORDS);
    setAnnouncementsAllowed(false);
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS);
    setAnnouncementsAllowed(true);
    announceReturned();
    expect(stub.announced).toEqual([]);
  });

  it("is dropped when the app leaves the foreground, so a timer firing on return says nothing", () => {
    announceAfterReturn(WORDS);
    appState.emit("background");
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS);
    expect(stub.announced).toEqual([]);
    expect(appState.listeners).toHaveLength(0);
  });

  it("says only the newest confirmation when two wait", () => {
    announceAfterReturn("First.");
    announceAfterReturn(WORDS);
    announceReturned();
    vi.advanceTimersByTime(ANNOUNCE_FALLBACK_MS * 2);
    expect(stub.announced).toEqual([WORDS]);
  });

  it("is said once more on iOS when VoiceOver reports it was cut off, and no more after that", () => {
    announceAfterReturn(WORDS);
    announceReturned();
    stub.emit("announcementFinished", { announcement: "Something else", success: false });
    expect(stub.announced).toEqual([WORDS]);
    stub.emit("announcementFinished", { announcement: WORDS, success: false });
    expect(stub.announcedWith).toEqual([
      { text: WORDS, options: { queue: true } },
      { text: WORDS, options: { queue: true } },
    ]);
    stub.emit("announcementFinished", { announcement: WORDS, success: false });
    expect(stub.announced).toHaveLength(2);
    expect(stub.listeners).toHaveLength(0);
  });

  it("stops listening once VoiceOver says it finished", () => {
    announceAfterReturn(WORDS);
    announceReturned();
    stub.emit("announcementFinished", { announcement: WORDS, success: true });
    expect(stub.announced).toEqual([WORDS]);
    expect(stub.listeners).toHaveLength(0);
  });
});

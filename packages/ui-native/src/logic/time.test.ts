import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatIsoCalendarDate,
  formatLastSynced,
  formatRelativeTime,
  formatTime,
  HOUR_MS,
  MINUTE_MS,
} from "./time";

const now = new Date("2026-10-09T13:05:00Z"); // 14:05 British Summer Time

describe("formatTime and formatDate (UK local time)", () => {
  it.each([
    ["2026-07-01T13:05:00Z", "14:05", "01/07/2026"], // BST, UTC+1
    ["2026-12-01T13:05:00Z", "13:05", "01/12/2026"], // GMT
    ["2026-03-29T00:59:00Z", "00:59", "29/03/2026"], // one minute before the clocks go forward
    ["2026-03-29T01:00:00Z", "02:00", "29/03/2026"], // clocks went forward
    ["2026-10-25T00:30:00Z", "01:30", "25/10/2026"], // first 01:30 on the day the clocks go back
    ["2026-10-25T01:30:00Z", "01:30", "25/10/2026"], // second 01:30
    ["2026-12-31T23:59:00Z", "23:59", "31/12/2026"],
  ])("%s is %s on %s", (iso, time, date) => {
    const value = new Date(iso);
    expect(formatTime(value)).toBe(time);
    expect(formatDate(value)).toBe(date);
  });
});

describe("formatIsoCalendarDate", () => {
  it.each([
    ["1940-03-01", "01/03/1940"],
    ["2000-02-29", "29/02/2000"],
    ["1940-03-01T00:00:00Z", "01/03/1940"],
  ])("%s becomes %s without a time-zone shift", (input, expected) => {
    expect(formatIsoCalendarDate(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "01/03/1940",
    "1941-02-29",
    "1940-13-01",
    "1940-00-10",
    "1940-04-31",
  ])("rejects %s", (input) => {
    expect(formatIsoCalendarDate(input)).toBeNull();
  });
});

describe("formatRelativeTime (British English)", () => {
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it.each([
    [0, "just now"],
    [59_999, "just now"],
    [MINUTE_MS, "1 minute ago"],
    [2 * MINUTE_MS - 1, "1 minute ago"],
    [2 * MINUTE_MS, "2 minutes ago"],
    [59 * MINUTE_MS, "59 minutes ago"],
    [HOUR_MS, "1 hour ago"],
    [2 * HOUR_MS, "2 hours ago"],
    [23 * HOUR_MS + 59 * MINUTE_MS, "23 hours ago"],
    [24 * HOUR_MS, "on 08/10/2026 at 14:05"],
    [3 * 24 * HOUR_MS + 30 * MINUTE_MS, "on 06/10/2026 at 13:35"],
  ])("%i ms ago reads %s", (ms, expected) => {
    expect(formatRelativeTime(ago(ms), now)).toBe(expected);
  });

  it("tolerates up to a minute of clock skew as just now", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 30_000), now)).toBe("just now");
  });

  it("shows an absolute time for a moment well in the future rather than a negative age", () => {
    expect(formatRelativeTime(new Date(now.getTime() + 2 * HOUR_MS), now)).toBe(
      "on 09/10/2026 at 16:05",
    );
  });
});

describe("formatLastSynced", () => {
  it("says when there has never been a sync", () => {
    expect(formatLastSynced(null, now)).toBe("Not synced yet");
    expect(formatLastSynced(undefined, now)).toBe("Not synced yet");
  });

  it("prefixes the relative time", () => {
    expect(formatLastSynced(new Date(now.getTime() - 5 * MINUTE_MS), now)).toBe(
      "Last synced 5 minutes ago",
    );
  });
});

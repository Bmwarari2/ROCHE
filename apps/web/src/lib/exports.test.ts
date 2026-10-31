import { describe, expect, it } from "vitest";
import {
  downloadFailureTarget,
  downloadProblem,
  exportChip,
  exportShown,
  exportStateOf,
  mayCancel,
  mayRequest,
  sizeWords,
} from "./exports";
import { t } from "./i18n";

describe("the full export page (PLAT-015; HZ-070)", () => {
  it("is shown only to holders of platform.export.create", () => {
    expect(exportShown(["platform.export.create"])).toBe(true);
    expect(exportShown(["platform.user.manage"])).toBe(false);
  });

  it.each([
    ["queued", null, "queued", "Waiting to start", "clock", true],
    ["running", null, "running", "Being prepared", "clock", true],
    ["ready", null, "ready", "Ready to download", "circle-check", true],
    ["ready", "2026-10-17T10:00:00Z", "downloaded", "Downloaded", "send", false],
    ["expired", null, "expired", "Expired", "circle-minus", false],
    ["failed", null, "failed", "Failed", "triangle-alert", false],
    ["revoked", null, "cancelled", "Cancelled", "circle-minus", false],
  ] as const)(
    "says %s (downloaded %s) as %s: an icon and a word; cancel offered: %s",
    (status, downloadedAt, state, label, icon, cancel) => {
      expect(exportStateOf({ status, downloadedAt })).toBe(state);
      expect(exportChip(state, t)).toMatchObject({ label, icon });
      expect(mayCancel(state)).toBe(cancel);
    },
  );

  it("warns about a state it does not know, never reading as calm", () => {
    expect(exportChip("archived", t)).toMatchObject({ status: "overdue", icon: "circle-alert" });
  });

  it("offers a new export only when none is being made", () => {
    expect(mayRequest([{ status: "ready" }, { status: "expired" }])).toBe(true);
    expect(mayRequest([{ status: "queued" }])).toBe(false);
    expect(mayRequest([{ status: "running" }])).toBe(false);
  });

  it.each([
    [null, null],
    [42_000, "Under 0.1 MB"],
    [12_400_000, "12.4 MB"],
  ])("gives the size %s as %s", (bytes, words) => {
    expect(sizeWords(bytes, t)).toBe(words);
  });

  it.each([
    ["step_up_required", "/sign-in?reason=step-up&next=%2Fsettings%2Fexport"],
    ["unauthenticated", "/sign-in?next=%2Fsettings%2Fexport"],
    ["export_already_downloaded", "/settings/export?problem=export_already_downloaded&at=1"],
    ["something_else", "/settings/export?problem=failed&at=1"],
    [undefined, "/settings/export?problem=failed&at=1"],
  ])("sends a refused download (%s) where the person can act", (code, target) => {
    expect(downloadFailureTarget(code, new Date(1))).toBe(target);
  });

  it("says only the download problems it knows", () => {
    expect(downloadProblem("export_expired")).toBe("export_expired");
    expect(downloadProblem("<script>")).toBeNull();
    expect(t("export.problem", { problem: "not_requester" })).toContain("Only the person");
  });
});

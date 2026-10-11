import { createTranslator, type MessageKey, type Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { describeDevice } from "./devices";

const t = createTranslator("en-GB");

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const EDGE_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const HARBOUR_ANDROID = "HarbourMobile/0.1.0 (Android 15; Pixel 9)";

describe("describeDevice", () => {
  it.each([
    [CHROME_WINDOWS, "Chrome on Windows"],
    [SAFARI_MAC, "Safari on macOS"],
    [SAFARI_IPHONE, "Safari on iOS"],
    [EDGE_WINDOWS, "Edge on Windows"],
    [EDGE_MAC, "Edge on macOS"],
    [FIREFOX_LINUX, "Firefox on Linux"],
    [HARBOUR_ANDROID, "Harbour app on Android"],
    ["okhttp/4.12.0", "Harbour app"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)", "ChromeOS"],
    ["curl/8.9.1", "Unknown device"],
    ["", "Unknown device"],
    [null, "Unknown device"],
    [undefined, "Unknown device"],
  ])("%j is %s", (userAgent, expected) => {
    expect(describeDevice(userAgent, t)).toBe(expected);
  });

  it("takes every word from the translator", () => {
    const keys: Translator = Object.assign(
      (key: MessageKey, values?: Record<string, unknown>) =>
        values ? `[${key} ${Object.values(values).join(" ")}]` : `[${key}]`,
      { locale: "cy" as const },
    );
    expect(describeDevice(CHROME_WINDOWS, keys)).toBe(
      "[security.device.browserOnSystem Chrome Windows]",
    );
    expect(describeDevice(HARBOUR_ANDROID, keys)).toBe(
      "[security.device.browserOnSystem [security.device.app] Android]",
    );
    expect(describeDevice(null, keys)).toBe("[security.device.unknown]");
  });
});

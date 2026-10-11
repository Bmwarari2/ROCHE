import type { Translator } from "@harbour/i18n";

/**
 * A short, human description of a signed-in device from its user agent, for the sessions list
 * ("Chrome on Windows"). Pure, unit tested. Deliberately coarse: no versions, no IP addresses.
 * Browser and system names are product names and stay as they are; the words around them come
 * from the catalogue.
 */

const APP = "app";

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\/|Chromium\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
  [/HarbourMobile|okhttp|Expo/i, APP],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

export function describeDevice(userAgent: string | null | undefined, t: Translator): string {
  if (!userAgent) return t("security.device.unknown");
  const match = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const browser = match === APP ? t("security.device.app") : match;
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return t("security.device.browserOnSystem", { browser, system });
  return browser ?? system ?? t("security.device.unknown");
}

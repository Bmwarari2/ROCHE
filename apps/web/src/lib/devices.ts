/**
 * A short, human description of a signed-in device from its user agent, for the sessions list
 * ("Chrome on Windows"). Pure, unit tested. Deliberately coarse: no versions, no IP addresses.
 */

const BROWSERS: readonly [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\/|Chromium\//, "Chrome"],
  [/Version\/[\d.]+.*Safari\//, "Safari"],
  [/HarbourMobile|okhttp|Expo/i, "Harbour app"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}

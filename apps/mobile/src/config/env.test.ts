import { describe, expect, it } from "vitest";
import { DEFAULT_API_URL, parseEnv } from "./env";

const dev = { allowInsecure: true };
const release = { allowInsecure: false };

describe("parseEnv", () => {
  it("defaults to the local API and live mode", () => {
    expect(parseEnv({}, dev)).toEqual({ apiUrl: DEFAULT_API_URL, demoMode: false });
  });

  it("strips trailing slashes", () => {
    expect(parseEnv({ EXPO_PUBLIC_API_URL: "https://api.example.invalid/" }, release).apiUrl).toBe(
      "https://api.example.invalid",
    );
    expect(
      parseEnv({ EXPO_PUBLIC_API_URL: "https://example.invalid/harbour//" }, release).apiUrl,
    ).toBe("https://example.invalid/harbour");
  });

  it.each(["1", "true", "YES", " on "])("treats %s as demo mode", (flag) => {
    expect(parseEnv({ EXPO_PUBLIC_DEMO_MODE: flag }, dev).demoMode).toBe(true);
  });

  it.each(["0", "false", "", undefined])("treats %s as live mode", (flag) => {
    expect(parseEnv({ EXPO_PUBLIC_DEMO_MODE: flag }, dev).demoMode).toBe(false);
  });

  it("allows http only to development hosts in development builds", () => {
    expect(parseEnv({ EXPO_PUBLIC_API_URL: "http://10.0.2.2:4000" }, dev).apiUrl).toBe(
      "http://10.0.2.2:4000",
    );
    expect(() => parseEnv({ EXPO_PUBLIC_API_URL: "http://localhost:4000" }, release)).toThrow(
      /https/,
    );
    expect(() => parseEnv({ EXPO_PUBLIC_API_URL: "http://api.example.invalid" }, dev)).toThrow(
      /https/,
    );
  });

  it("does not care about http in demo mode, where the API is never contacted", () => {
    expect(
      parseEnv(
        { EXPO_PUBLIC_API_URL: "http://localhost:4000", EXPO_PUBLIC_DEMO_MODE: "1" },
        release,
      ).demoMode,
    ).toBe(true);
  });

  it("rejects invalid URLs and other protocols", () => {
    expect(() => parseEnv({ EXPO_PUBLIC_API_URL: "not a url" }, dev)).toThrow(/valid URL/);
    expect(() => parseEnv({ EXPO_PUBLIC_API_URL: "ftp://example.invalid" }, dev)).toThrow(/https/);
  });
});

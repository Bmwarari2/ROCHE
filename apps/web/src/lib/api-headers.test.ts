import { describe, expect, it } from "vitest";
import { apiRequestHeaders, callerHeaders } from "./api-headers";

const PROXIES = ["10.0.0.0/8"];

describe("apiRequestHeaders", () => {
  it("passes on the cookie, the user agent, a well-formed request id and the client address", () => {
    const incoming = new Headers({
      cookie: "harbour.session_token=abc",
      "user-agent": "Mozilla/5.0",
      "x-request-id": "0194d000-0000-7000-8000-000000000301",
      "x-forwarded-for": "203.0.113.9, 192.0.2.10, 10.0.0.5",
      origin: "https://app.example.invalid",
    });
    expect(apiRequestHeaders(incoming, PROXIES)).toEqual({
      cookie: "harbour.session_token=abc",
      "user-agent": "Mozilla/5.0",
      "x-request-id": "0194d000-0000-7000-8000-000000000301",
      "x-forwarded-for": "192.0.2.10",
    });
  });

  it.each([
    ["free text with personal data", "Ada Example 9990000000"],
    ["a name and an NHS number in an id's shape", "Ada-Example-9434765919"],
    ["not a UUID", "web-req-42"],
    ["markup", "<script>alert(1)</script>"],
  ])(
    "drops a request id that is %s (security reviews, 31 October 2026 and of #134, M4)",
    (_label, value) => {
      const out = apiRequestHeaders(
        new Headers({ cookie: "harbour.session_token=abc", "x-request-id": value }),
        PROXIES,
      );
      expect(out).toEqual({ cookie: "harbour.session_token=abc" });
    },
  );
});

describe("callerHeaders (the public evidence pages)", () => {
  it("passes on the user agent, a UUID request id and the client address, never a cookie", () => {
    const incoming = new Headers({
      cookie: "harbour.evidence_session=abc",
      "user-agent": "Mozilla/5.0",
      "x-request-id": "3f2b8c1e-9d4a-4f6b-8e2c-1a5b7c9d0e4f",
      "x-forwarded-for": "192.0.2.10, 10.0.0.5",
    });
    expect(callerHeaders(incoming, PROXIES)).toEqual({
      "user-agent": "Mozilla/5.0",
      "x-request-id": "3f2b8c1e-9d4a-4f6b-8e2c-1a5b7c9d0e4f",
      "x-forwarded-for": "192.0.2.10",
    });
  });

  it("drops a request id that is not a UUID (security reviews, 31 October 2026 and of #134, M4)", () => {
    const incoming = new Headers({
      "user-agent": "Mozilla/5.0",
      "x-request-id": "Ada-Example-9434765919",
    });
    expect(callerHeaders(incoming, PROXIES)).toEqual({ "user-agent": "Mozilla/5.0" });
  });
});

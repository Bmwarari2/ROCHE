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
    ["an id longer than 64 characters", "a".repeat(65)],
    ["markup", "<script>alert(1)</script>"],
  ])(
    "drops a request id that is %s, so the API makes its own (security review, 31 October 2026)",
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
  it("passes on the user agent, a well-formed request id and the client address, never a cookie", () => {
    const incoming = new Headers({
      cookie: "harbour.evidence_session=abc",
      "user-agent": "Mozilla/5.0",
      "x-request-id": "evidence-req-7",
      "x-forwarded-for": "192.0.2.10, 10.0.0.5",
    });
    expect(callerHeaders(incoming, PROXIES)).toEqual({
      "user-agent": "Mozilla/5.0",
      "x-request-id": "evidence-req-7",
      "x-forwarded-for": "192.0.2.10",
    });
  });

  it("drops a request id that is not well formed (security review, 31 October 2026)", () => {
    const incoming = new Headers({
      "user-agent": "Mozilla/5.0",
      "x-request-id": "Ada Example ada@example.invalid",
    });
    expect(callerHeaders(incoming, PROXIES)).toEqual({ "user-agent": "Mozilla/5.0" });
  });
});

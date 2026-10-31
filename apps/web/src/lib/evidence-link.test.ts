import { describe, expect, it } from "vitest";
import {
  evidenceTokenFromFragment,
  isFinal,
  linkRefusal,
  readEvidenceCode,
  retryMinutes,
  sessionCookie,
} from "./evidence-link";

const TOKEN = "a".repeat(43);

describe("the public evidence pack page (quality.md section 16; ADR-0050; HZ-050)", () => {
  it("hazard HZ-050 reads the token only from the fragment, and only in its own shape", () => {
    expect(evidenceTokenFromFragment(`#${TOKEN}`)).toBe(TOKEN);
    expect(evidenceTokenFromFragment(TOKEN)).toBe(TOKEN);
    expect(evidenceTokenFromFragment("")).toBeNull();
    expect(evidenceTokenFromFragment(`#${TOKEN}x`)).toBeNull();
    expect(evidenceTokenFromFragment("#not a token")).toBeNull();
  });

  it("takes six digits, spaces ignored, and nothing else", () => {
    expect(readEvidenceCode("123 456")).toBe("123456");
    expect(readEvidenceCode("12345")).toBeNull();
    expect(readEvidenceCode("12345a")).toBeNull();
  });

  it.each<[number, string | undefined, string | null, unknown]>([
    [429, "too_many_codes", "600", { kind: "throttled", minutes: 10 }],
    [404, "not_found", null, { kind: "not_found" }],
    [422, "wrong_code", null, { kind: "wrong_code" }],
    [422, "invalid", null, { kind: "malformed" }],
    [401, "link_code_required", null, { kind: "code_required" }],
    [410, "link_revoked", null, { kind: "ended", reason: "revoked" }],
    [410, "link_expired", null, { kind: "ended", reason: "expired" }],
    [410, "link_locked", null, { kind: "ended", reason: "locked" }],
    [403, "link_wrong_recipient", null, { kind: "ended", reason: "wrong_recipient" }],
    [410, "something_new", null, { kind: "unavailable" }],
    [500, undefined, null, { kind: "unavailable" }],
  ])("hazard HZ-050 says a %i %s refusal in the page's terms", (status, code, retry, result) => {
    expect(linkRefusal(status, code, retry)).toEqual(result);
  });

  it("stops offering codes once a link will never open again", () => {
    expect(isFinal({ kind: "ended", reason: "locked" })).toBe(true);
    expect(isFinal({ kind: "not_found" })).toBe(true);
    expect(isFinal({ kind: "wrong_code" })).toBe(false);
    expect(retryMinutes(null)).toBe(1);
    expect(retryMinutes("61")).toBe(2);
  });

  it("hazard HZ-050 passes on only this link's session cookie, never the browser's others", () => {
    expect(
      sessionCookie("theme=dark; __Host-harbour_evidence_session=abc.def=; harbour_session=xyz"),
    ).toBe("abc.def=");
    expect(sessionCookie("harbour_session=xyz")).toBeNull();
    expect(sessionCookie(null)).toBeNull();
  });
});

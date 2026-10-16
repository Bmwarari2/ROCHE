import { describe, expect, it } from "vitest";
import {
  classifyInbound,
  deliveryOutcome,
  outboundBodyProblem,
  outboundTitleProblem,
} from "./ports";

describe("outboundTitleProblem (no personal data leaves Harbour)", () => {
  it.each([
    ["A visit was missed", null],
    ["A record was opened with break-glass access", null],
    ["", "Title is empty."],
    ["x".repeat(81), "Title is too long for a generic alert."],
    ["Ada 999 000 0018 fell", "Title looks like it contains an NHS number."],
    ["Born 01/02/1938", "Title looks like it contains a date."],
    ["Call ada@example.invalid", "Title looks like it contains an email address."],
    ["Ring 07700 900123", "Title looks like it contains a phone number."],
    ["Ring +44 7700 900123", "Title looks like it contains a phone number."],
  ])("%s", (title, expected) => {
    expect(outboundTitleProblem(title)).toBe(expected);
  });
});

describe("deliveryOutcome", () => {
  it.each([
    [{ ok: true, providerMessageId: "m1" }, 1, { status: "sent", providerMessageId: "m1" }],
    [
      { ok: false, retryable: true, error: "Timeout" },
      1,
      { status: "pending", retryInSeconds: 30, error: "Timeout" },
    ],
    [
      { ok: false, retryable: true, error: "Timeout" },
      3,
      { status: "pending", retryInSeconds: 120, error: "Timeout" },
    ],
    [{ ok: false, retryable: true, error: "Timeout" }, 5, { status: "failed", error: "Timeout" }],
    [
      { ok: false, retryable: false, error: "Rejected" },
      1,
      { status: "failed", error: "Rejected" },
    ],
  ] as const)("%o after %s attempts", (result, attempts, expected) => {
    expect(deliveryOutcome(result, attempts)).toEqual(expected);
  });

  it("caps the backoff at an hour", () => {
    expect(deliveryOutcome({ ok: false, retryable: true, error: "x" }, 12, 20)).toEqual({
      status: "pending",
      retryInSeconds: 3600,
      error: "x",
    });
  });
});

describe("classifyInbound", () => {
  it("accepts clean data and quarantines anything with problems", () => {
    expect(classifyInbound([])).toEqual({ status: "accepted" });
    expect(classifyInbound([{ path: "amount", message: "Required" }])).toEqual({
      status: "quarantined",
      problems: [{ path: "amount", message: "Required" }],
    });
  });
});

describe("outboundBodyProblem (an email body carries no link and no NHS number)", () => {
  it.each([
    ["Your code is 123456.", null],
    ["Dear Eve Example,\n\nYour fee changes on 01/11/2026.", null],
    ["Open https://evil.example.invalid now", "Body contains a link."],
    ["See www.example.invalid", "Body contains a link."],
    ["NHS number 999 123 4567", "Body looks like it contains an NHS number."],
    ["Call the home on 01632 960000.", null],
  ])("%s", (body, expected) => {
    expect(outboundBodyProblem(body)).toBe(expected);
  });
});

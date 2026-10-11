import { describe, expect, it } from "vitest";
import { PORTS } from "../integrations/ports";
import { isPlausibleEmail } from "../shared/email";
import {
  applyFamilyChannelEvent,
  checkFamilyChannelAddress,
  classifySmsReply,
  clickToCallLink,
  FAMILY_CHANNEL_KINDS,
  FAMILY_CHANNEL_PORTS,
  type FamilyChannelEvent,
  type FamilyChannelState,
  familyChannelUsability,
  isUkMobile,
  toE164,
} from "./channels";

/**
 * Family notification channels (comms.md section 4 rule 14; ADR-0060). Fixtures use
 * example.invalid addresses and the Ofcom drama ranges (07700 900xxx, 01632 960xxx).
 */

const AT = new Date("2026-10-11T10:00:00Z");

function channel(overrides: Partial<FamilyChannelState> = {}): FamilyChannelState {
  return {
    id: "channel-1",
    contactId: "contact-ben",
    kind: "email",
    address: "ben@example.invalid",
    verifiedAt: new Date("2026-10-01T10:00:00Z"),
    updatesOn: true,
    optedOutAt: null,
    suspendedAt: null,
    suspendedReason: null,
    ...overrides,
  };
}

describe("channels map onto the integration ports", () => {
  it("sends each kind through its own port", () => {
    for (const kind of FAMILY_CHANNEL_KINDS) expect(PORTS).toContain(FAMILY_CHANNEL_PORTS[kind]);
    expect(FAMILY_CHANNEL_PORTS).toEqual({
      email: "comms.email",
      sms: "comms.sms",
      push: "comms.push",
    });
  });
});

describe("whether a channel may carry an update notification", () => {
  it.each<[string, Partial<FamilyChannelState>, ReturnType<typeof familyChannelUsability>]>([
    ["verified and switched on", {}, { usable: true }],
    ["not verified", { verifiedAt: null }, { usable: false, reason: "not_verified" }],
    [
      "switched off (opt-in by default)",
      { updatesOn: false },
      { usable: false, reason: "updates_off" },
    ],
    ["opted out", { optedOutAt: AT }, { usable: false, reason: "opted_out" }],
    [
      "suspended after a hard bounce",
      { suspendedAt: AT, suspendedReason: "hard_bounce" },
      { usable: false, reason: "hard_bounce" },
    ],
    [
      "suspended with no reason recorded",
      { suspendedAt: AT, suspendedReason: null },
      { usable: false, reason: "suspended" },
    ],
    [
      "opted out and suspended (opt-out wins)",
      { optedOutAt: AT, suspendedAt: AT, suspendedReason: "complaint" },
      { usable: false, reason: "opted_out" },
    ],
  ])("%s", (_label, overrides, expected) => {
    expect(familyChannelUsability(channel(overrides))).toEqual(expected);
  });
});

describe("bounces, complaints and opt-outs from any provider", () => {
  const email = channel();
  const sms = channel({ id: "channel-2", kind: "sms", address: "+447700900123" });
  const push = channel({ id: "channel-3", kind: "push", address: "ExpoPushToken[example]" });

  it.each<
    [
      string,
      FamilyChannelState,
      FamilyChannelEvent,
      Partial<FamilyChannelState> | null,
      string | null,
    ]
  >([
    [
      "a permanent email bounce",
      email,
      { type: "bounced", permanent: true, at: AT },
      { suspendedAt: AT, suspendedReason: "hard_bounce" },
      "comms.channel.suspended",
    ],
    [
      "an undeliverable SMS",
      sms,
      { type: "bounced", permanent: true, at: AT },
      { suspendedAt: AT, suspendedReason: "hard_bounce" },
      "comms.channel.suspended",
    ],
    [
      "a temporary bounce (retried)",
      email,
      { type: "bounced", permanent: false, at: AT },
      null,
      null,
    ],
    ["a bounce reported for push", push, { type: "bounced", permanent: true, at: AT }, null, null],
    [
      "a spam complaint",
      email,
      { type: "complained", at: AT },
      { suspendedAt: AT, suspendedReason: "complaint" },
      "comms.channel.suspended",
    ],
    ["a complaint on SMS", sms, { type: "complained", at: AT }, null, null],
    [
      "an unregistered device",
      push,
      { type: "device_not_registered", at: AT },
      { suspendedAt: AT, suspendedReason: "device_not_registered" },
      "comms.channel.suspended",
    ],
    [
      "an unregistered device on email",
      email,
      { type: "device_not_registered", at: AT },
      null,
      null,
    ],
    [
      "STOP by SMS",
      sms,
      { type: "opted_out", via: "sms_reply", at: AT },
      { optedOutAt: AT, updatesOn: false },
      "comms.channel.opted_out",
    ],
    [
      "an email unsubscribe link",
      email,
      { type: "opted_out", via: "email_link", at: AT },
      { optedOutAt: AT, updatesOn: false },
      "comms.channel.opted_out",
    ],
    [
      "an SMS reply against an email channel",
      email,
      { type: "opted_out", via: "sms_reply", at: AT },
      null,
      null,
    ],
    [
      "a second opt-out",
      channel({ optedOutAt: AT, updatesOn: false }),
      { type: "opted_out", via: "portal", at: AT },
      null,
      null,
    ],
    [
      "opting back in through the portal",
      channel({ optedOutAt: AT, updatesOn: false }),
      { type: "opted_in", via: "portal", at: AT },
      { optedOutAt: null, updatesOn: true },
      "comms.channel.opted_in",
    ],
    [
      "START by SMS",
      channel({ kind: "sms", address: "+447700900123", optedOutAt: AT, updatesOn: false }),
      { type: "opted_in", via: "sms_reply", at: AT },
      { optedOutAt: null, updatesOn: true },
      "comms.channel.opted_in",
    ],
    ["START by SMS against push", push, { type: "opted_in", via: "sms_reply", at: AT }, null, null],
    ["opting in when already on", email, { type: "opted_in", via: "portal", at: AT }, null, null],
    [
      "verification",
      channel({ verifiedAt: null }),
      { type: "verified", at: AT },
      { verifiedAt: AT },
      "comms.channel.verified",
    ],
    [
      "a new address after a bounce",
      channel({ suspendedAt: AT, suspendedReason: "hard_bounce" }),
      { type: "address_changed", address: "ben.new@example.invalid", at: AT },
      {
        address: "ben.new@example.invalid",
        verifiedAt: null,
        suspendedAt: null,
        suspendedReason: null,
      },
      "comms.channel.address_changed",
    ],
    [
      "a second bounce",
      channel({ suspendedAt: AT, suspendedReason: "hard_bounce" }),
      { type: "bounced", permanent: true, at: AT },
      null,
      null,
    ],
  ])("handles %s", (_label, before, event, changes, audit) => {
    const result = applyFamilyChannelEvent(before, event);
    if (changes === null) {
      expect(result.changed).toBe(false);
      expect(result.state).toBe(before);
    } else {
      expect(result).toEqual({ changed: true, state: { ...before, ...changes }, audit });
    }
  });

  it("explains why nothing changed", () => {
    const result = applyFamilyChannelEvent(email, { type: "bounced", permanent: false, at: AT });
    expect(result).toMatchObject({ changed: false, why: expect.stringContaining("retried") });
  });
});

describe("SMS replies", () => {
  it.each<[string, ReturnType<typeof classifySmsReply>]>([
    ["STOP", "opt_out"],
    ["  stop ", "opt_out"],
    ["Stop.", "opt_out"],
    ["STOP!", "opt_out"],
    ["STOPALL", "opt_out"],
    ["unsubscribe", "opt_out"],
    ["Cancel", "opt_out"],
    ["END", "opt_out"],
    ["quit", "opt_out"],
    ["START", "opt_in"],
    ["unstop", "opt_in"],
    ["stop please", "not_a_keyword"],
    ["Is Ada ok?", "not_a_keyword"],
    ["", "not_a_keyword"],
    ["...", "not_a_keyword"],
  ])("reads %j as %s", (text, expected) => {
    expect(classifySmsReply(text)).toBe(expected);
  });
});

describe("addresses", () => {
  it.each<[string, boolean]>([
    ["ben@example.invalid", true],
    ["ben.example+updates@mail.example.invalid", true],
    ["ben@example", false],
    ["@example.invalid", false],
    ["ben@", false],
    ["ben@@example.invalid", false],
    ["ben @example.invalid", false],
    ["ben@.invalid", false],
    ["ben@example..invalid", false],
    ["ben@example.invalid.", false],
    ["", false],
    [`${"b".repeat(254)}@example.invalid`, false],
  ])("treats %j as a plausible email: %s", (address, expected) => {
    expect(isPlausibleEmail(address)).toBe(expected);
  });

  it.each<[string, string | null]>([
    ["07700 900123", "+447700900123"],
    ["07700-900123", "+447700900123"],
    ["+44 7700 900123", "+447700900123"],
    ["0044 7700 900123", "+447700900123"],
    ["(01632) 960001", "+441632960001"],
    ["+1 202 555 0143", "+12025550143"],
    ["7700900123", null],
    ["+44 7700 9001x3", null],
    ["++447700900123", null],
    ["+0123456789", null],
    ["+1234567", null],
    ["+1234567890123456", null],
    ["", null],
  ])("writes %j in E.164 as %s", (raw, expected) => {
    expect(toE164(raw)).toBe(expected);
  });

  it("recognises UK mobile numbers", () => {
    expect(isUkMobile("+447700900123")).toBe(true);
    expect(isUkMobile("+441632960001")).toBe(false);
    expect(isUkMobile("+4477009001234")).toBe(false);
  });

  it.each<[FamilyChannelState["kind"], string, boolean]>([
    ["email", "ben@example.invalid", true],
    ["email", "not an address", false],
    ["email", " ben@example.invalid", false],
    // A Cyrillic "е" in place of the Latin "e": one address must stay one string.
    ["email", "b\u0435n@example.invalid", false],
    ["sms", "+447700900123", true],
    ["sms", "07700 900123", false],
    ["push", "ExpoPushToken[example]", true],
    ["push", "  ", false],
  ])("checks a %s address %j: %s", (kind, address, expected) => {
    expect(checkFamilyChannelAddress(kind, address)).toBe(expected);
  });

  it("makes a click-to-call link for the home's number only when it is a real number", () => {
    expect(clickToCallLink("01632 960001")).toBe("tel:+441632960001");
    expect(clickToCallLink("call reception")).toBeNull();
  });
});

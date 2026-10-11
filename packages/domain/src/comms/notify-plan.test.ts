import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { MAX_OUTBOUND_TITLE_LENGTH } from "../integrations/ports";
import type { QuietHours } from "../platform/notifications";
import { RateNotFoundError, type RateRow } from "../platform/rates";
import type { FamilyChannelState } from "./channels";
import { FEED_CLINICAL_TERMS } from "./feed-text";
import {
  checkFamilyNotificationTemplate,
  currentFamilyTemplate,
  FAMILY_UPDATES_PATH,
  type FamilyNotificationRequest,
  type FamilyNotificationTemplate,
  familyUpdatesLink,
  isValidQuietHours,
  planFamilyNotification,
  quietHoursRelease,
} from "./notify-plan";
import {
  COMMS_RATE_KEYS,
  type CommsRateName,
  familyQuietHours,
  minuteOfDayToHhMm,
  resolveCommsRates,
} from "./notify-rates";

/**
 * Family update notifications (comms.md section 4 rules 13 and 15; hazard HZ-060). Quiet hours come
 * from docs/specs/rates.md. Invented people: Ada Example and her son Ben; addresses on
 * example.invalid and the Ofcom drama range.
 */

const rows = readRateTable();
const QUIET: QuietHours = familyQuietHours(resolveCommsRates(rows, "england", "2026-10-11", null));
const NOON = new Date("2026-10-11T11:00:00Z"); // 12:00 BST
const PORTAL = "https://family.harbour.example";
const LINK = `${PORTAL}${FAMILY_UPDATES_PATH}`;
const APPROVED = new Date("2026-01-05T09:00:00Z");

function template(overrides: Partial<FamilyNotificationTemplate> = {}): FamilyNotificationTemplate {
  return {
    key: "family.update.email",
    version: 1,
    channel: "email",
    text: "There is a new update in the family portal.",
    approvedAt: APPROVED,
    approvedBy: "user-manager",
    withdrawnAt: null,
    ...overrides,
  };
}

const TEMPLATES = [
  template(),
  template({
    key: "family.update.sms",
    channel: "sms",
    text: "New update from the care home. Sign in to read it.",
  }),
  template({ key: "family.update.push", channel: "push", text: "New update" }),
];

function channel(overrides: Partial<FamilyChannelState> = {}): FamilyChannelState {
  return {
    id: "email-1",
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

const CHANNELS = [
  channel(),
  channel({ id: "sms-1", kind: "sms", address: "+447700900123" }),
  channel({ id: "push-1", kind: "push", address: "ExpoPushToken[phone]" }),
  channel({ id: "push-2", kind: "push", address: "ExpoPushToken[tablet]" }),
];

function request(overrides: Partial<FamilyNotificationRequest> = {}): FamilyNotificationRequest {
  return {
    notificationId: "notification-1",
    newItemIds: ["item-1"],
    alreadyPending: false,
    channels: CHANNELS,
    templates: TEMPLATES,
    personNames: ["Ada", "Example"],
    portalBaseUrl: PORTAL,
    tenantQuietHours: QUIET,
    ownQuietHours: null,
    now: NOON,
    ...overrides,
  };
}

describe("quiet hours come from the rate table", () => {
  it("finds every comms key in docs/specs/rates.md for each nation", () => {
    for (const nation of ["england", "wales", "scotland", "northern_ireland"] as const) {
      const rates = resolveCommsRates(rows, nation, "2026-10-11", null);
      for (const name of Object.keys(COMMS_RATE_KEYS) as CommsRateName[]) {
        const row = rows.find((r) => r.key === COMMS_RATE_KEYS[name] && r.validTo === null);
        expect(rates[name]).toBe(Number(row?.value));
      }
    }
  });

  it("turns the minutes into the notification centre's HH:MM form", () => {
    const rates = resolveCommsRates(rows, "england", "2026-10-11", null);
    expect(QUIET).toEqual({
      start: minuteOfDayToHhMm(rates.familyQuietStartMinute),
      end: minuteOfDayToHhMm(rates.familyQuietEndMinute),
    });
    expect(isValidQuietHours(QUIET)).toBe(true);
  });

  it("lets a tenant's own setting win", () => {
    const override: RateRow = {
      key: COMMS_RATE_KEYS.familyQuietStartMinute,
      value: "1320",
      unit: "minute_of_day",
      nation: "all",
      validFrom: "2026-01-01",
      validTo: null,
      tenantId: "tenant-a",
      verificationStatus: "tenant",
      source: "tenant policy",
    };
    expect(
      familyQuietHours(resolveCommsRates([...rows, override], "england", "2026-10-11", "tenant-a"))
        .start,
    ).toBe("22:00");
  });

  it("fails loudly when a figure is missing rather than guessing", () => {
    const without = rows.filter((r) => r.key !== COMMS_RATE_KEYS.familyQuietEndMinute);
    expect(() => resolveCommsRates(without, "england", "2026-10-11", null)).toThrow(
      RateNotFoundError,
    );
  });

  it.each<[number, string]>([
    [0, "00:00"],
    [480, "08:00"],
    [1439, "23:59"],
  ])("writes minute %i as %s", (minute, text) => {
    expect(minuteOfDayToHhMm(minute)).toBe(text);
  });

  it.each([-1, 1440, 7.5])("refuses %d as a minute of the day", (minute) => {
    expect(() => minuteOfDayToHhMm(minute)).toThrow(RangeError);
  });
});

describe("hazard HZ-060 notifications carry no health details", () => {
  it("hazard HZ-060 sends only the approved words and a link with no ids, whatever the updates are", () => {
    const one = planFamilyNotification(request({ newItemIds: ["item-1"] }));
    const many = planFamilyNotification(request({ newItemIds: ["item-2", "item-3", "item-4"] }));
    expect(one).toEqual(many);
    expect(one.action).toBe("send");
    if (one.action !== "send") return;
    for (const delivery of one.deliveries) {
      const template = TEMPLATES.find((t) => t.channel === delivery.channel);
      expect(delivery.message.title).toBe(template?.text);
      expect(delivery.message.link).toBe(LINK);
      const { to: _to, ...rest } = delivery.message;
      const out = JSON.stringify(rest);
      for (const secret of ["Ada", "Example", "item-1", "person-ada", "contact-ben"]) {
        expect(out).not.toContain(secret);
      }
    }
  });

  it.each<[string, string, readonly string[]]>([
    [
      "a score and the person's name",
      "Ada's NEWS2 score has changed.",
      ["clinical_term", "names_the_person"],
    ],
    ["a diagnosis", "New update: chest infection.", ["clinical_term"]],
    ["a prognosis", "Update about end of life care.", ["clinical_term"]],
    ["the person's surname in lower case", "an update about mrs example", ["names_the_person"]],
    ["a merge field", "New update about {name}.", ["has_placeholder"]],
    ["an NHS number", "Update for 999 123 4567", ["not_generic"]],
    ["a date", "Update from 11/10/2026", ["not_generic"]],
    ["a phone number", "Call 07700 900123 about the update", ["not_generic"]],
    ["an email address", "Reply to home@care.invalid", ["not_generic"]],
    ["a long message", "x".repeat(MAX_OUTBOUND_TITLE_LENGTH + 1), ["not_generic"]],
  ])("hazard HZ-060 refuses a template with %s", (_label, text, problems) => {
    const found = checkFamilyNotificationTemplate(template({ text }), {
      personNames: ["Ada", "Example"],
      now: NOON,
    });
    expect(found.map((p) => p.problem)).toEqual(problems);
  });

  it("hazard HZ-060 skips a channel whose template is not allowed, and says why", () => {
    const plan = planFamilyNotification(
      request({
        channels: [channel({ id: "sms-1", kind: "sms", address: "+447700900123" })],
        templates: [template({ channel: "sms", text: "Ada had a fall. Please call." })],
      }),
    );
    expect(plan).toMatchObject({
      action: "none",
      reason: "no_channel",
      skipped: [{ channelId: "sms-1", channel: "sms", reason: "template_not_allowed" }],
    });
    if (plan.action === "none") {
      expect(plan.skipped[0]?.problems.map((p) => p.problem)).toEqual(["names_the_person"]);
    }
  });

  it("hazard HZ-060 keeps every validated tool name out of templates", () => {
    for (const tool of FEED_CLINICAL_TERMS.filter((t) => t.kind === "validated_tool_or_score")) {
      const word = tool.words.join(" ");
      const problems = checkFamilyNotificationTemplate(template({ text: `New ${word} update` }), {
        personNames: [],
        now: NOON,
      });
      expect(problems.map((p) => p.problem)).toContain("clinical_term");
    }
  });

  it.each<[string, Partial<FamilyNotificationTemplate>, readonly string[]]>([
    ["not approved", { approvedAt: null }, ["not_approved"]],
    ["approved by nobody", { approvedBy: null }, ["not_approved"]],
    ["approved later", { approvedAt: new Date("2026-10-12T09:00:00Z") }, ["not_approved"]],
    ["withdrawn", { withdrawnAt: new Date("2026-10-05T09:00:00Z") }, ["withdrawn"]],
    ["withdrawn later on", { withdrawnAt: new Date("2026-10-12T09:00:00Z") }, []],
  ])("checks a template that is %s", (_label, overrides, problems) => {
    expect(
      checkFamilyNotificationTemplate(template(overrides), { personNames: ["Ada"], now: NOON }).map(
        (p) => p.problem,
      ),
    ).toEqual(problems);
  });
});

describe("templates and the link", () => {
  it("uses the latest approved version for each channel", () => {
    const templates = [
      template({ version: 1 }),
      template({ version: 3, text: "Version 3", approvedAt: null }),
      template({ version: 2, text: "Version 2" }),
      template({ version: 4, text: "Version 4", withdrawnAt: APPROVED }),
      template({ version: 9, channel: "sms" }),
    ];
    expect(currentFamilyTemplate(templates, "email", NOON)?.version).toBe(2);
    expect(currentFamilyTemplate(templates, "push", NOON)).toBeNull();
  });

  it.each<[string, string | null]>([
    ["https://family.harbour.example", LINK],
    ["https://family.harbour.example/", LINK],
    [" HTTPS://Family.Harbour.Example ", LINK],
    ["https://family.harbour.example:8443", "https://family.harbour.example:8443/family/updates"],
    ["http://family.harbour.example", null],
    ["https://family.harbour.example/people/ada", null],
    ["https://family.harbour.example?person=ada", null],
    ["https://family.harbour.example#ada", null],
    ["https://ben@family.harbour.example", null],
    ["https://localhost", null],
    ["https://.harbour.example", null],
    ["https://", null],
  ])("links %j to %s", (base, link) => {
    expect(familyUpdatesLink(base)).toBe(link);
  });
});

describe("who is told, on which channels", () => {
  it("sends one email, one SMS and one push to every device", () => {
    const plan = planFamilyNotification(request());
    expect(plan).toMatchObject({
      action: "send",
      deliverAt: NOON,
      heldForQuietHours: false,
      skipped: [],
    });
    if (plan.action !== "send") return;
    expect(
      plan.deliveries.map((d) => [
        d.channel,
        d.port,
        d.channelIds,
        d.message.idempotencyKey,
        d.message.to,
      ]),
    ).toEqual([
      ["email", "comms.email", ["email-1"], "notification-1:email-1", "ben@example.invalid"],
      ["sms", "comms.sms", ["sms-1"], "notification-1:sms-1", "+447700900123"],
      [
        "push",
        "comms.push",
        ["push-1", "push-2"],
        "notification-1:push",
        ["ExpoPushToken[phone]", "ExpoPushToken[tablet]"],
      ],
    ]);
    expect(plan.deliveries[0]).toMatchObject({
      templateKey: "family.update.email",
      templateVersion: 1,
    });
  });

  it.each<[string, Partial<FamilyNotificationRequest>, string]>([
    ["no new updates", { newItemIds: [] }, "no_new_updates"],
    [
      "a notification already waiting (it covers the new updates)",
      { alreadyPending: true },
      "already_pending",
    ],
    ["no channels", { channels: [] }, "no_channel"],
    [
      "a misconfigured portal address",
      { portalBaseUrl: "http://family.harbour.example" },
      "portal_link_not_valid",
    ],
  ])("sends nothing for %s", (_label, overrides, reason) => {
    expect(planFamilyNotification(request(overrides))).toMatchObject({ action: "none", reason });
  });

  it("skips channels that cannot carry updates and says why", () => {
    const plan = planFamilyNotification(
      request({
        channels: [
          channel({ id: "a", optedOutAt: NOON }),
          channel({ id: "b", verifiedAt: null }),
          channel({ id: "c", updatesOn: false }),
          channel({ id: "d", suspendedAt: NOON, suspendedReason: "complaint" }),
          channel({ id: "e", address: "not an address" }),
          channel({ id: "f", kind: "sms", address: "+447700900123" }),
        ],
        templates: [template()],
      }),
    );
    expect(plan).toMatchObject({ action: "none", reason: "no_channel" });
    expect(plan.skipped.map((s) => [s.channelId, s.reason])).toEqual([
      ["a", "opted_out"],
      ["b", "not_verified"],
      ["c", "updates_off"],
      ["d", "complaint"],
      ["e", "address_not_valid"],
      ["f", "no_approved_template"],
    ]);
  });
});

describe("quiet hours always apply to family updates, on the UK clock", () => {
  const sendAt = (now: Date, ownQuietHours: QuietHours | null = null) => {
    const plan = planFamilyNotification(request({ now, ownQuietHours }));
    if (plan.action !== "send") throw new Error("Expected a send");
    return { at: plan.deliverAt.toISOString(), held: plan.heldForQuietHours };
  };

  it.each<[string, string, string, boolean]>([
    ["midday goes at once", "2026-10-11T11:00:00Z", "2026-10-11T11:00:00.000Z", false],
    ["23:00 BST waits until 08:00 BST", "2026-10-11T22:00:00Z", "2026-10-12T07:00:00.000Z", true],
    [
      "06:00 BST waits until 08:00 the same morning",
      "2026-10-12T05:00:00Z",
      "2026-10-12T07:00:00.000Z",
      true,
    ],
    [
      "the night the clocks go back: 23:00 BST waits until 08:00 GMT",
      "2026-10-24T22:00:00Z",
      "2026-10-25T08:00:00.000Z",
      true,
    ],
    [
      "the night the clocks go forward: 23:00 GMT waits until 08:00 BST",
      "2026-03-28T23:00:00Z",
      "2026-03-29T07:00:00.000Z",
      true,
    ],
    ["exactly 08:00 goes at once", "2026-10-12T07:00:00Z", "2026-10-12T07:00:00.000Z", false],
  ])("%s", (_label, now, at, held) => {
    expect(sendAt(new Date(now))).toEqual({ at, held });
  });

  it("applies the family member's own window as well as the tenant's", () => {
    expect(sendAt(new Date("2026-10-11T22:00:00Z"), { start: "07:00", end: "09:30" })).toEqual({
      at: "2026-10-12T08:30:00.000Z",
      held: true,
    });
    expect(sendAt(new Date("2026-10-11T12:00:00Z"), { start: "12:30", end: "14:00" })).toEqual({
      at: "2026-10-11T13:00:00.000Z",
      held: true,
    });
  });

  it("lets the tenant's window decide when the two cover the whole day", () => {
    expect(sendAt(new Date("2026-10-11T22:00:00Z"), { start: "07:00", end: "22:00" })).toEqual({
      at: "2026-10-12T07:00:00.000Z",
      held: true,
    });
  });

  it("does nothing without windows and refuses a malformed one", () => {
    expect(quietHoursRelease([], NOON)).toBeNull();
    expect(() => quietHoursRelease([{ start: "9pm", end: "08:00" }], NOON)).toThrow(RangeError);
  });

  it.each<[QuietHours, boolean]>([
    [{ start: "21:00", end: "08:00" }, true],
    [{ start: "00:00", end: "23:59" }, true],
    [{ start: "24:00", end: "08:00" }, false],
    [{ start: "21:60", end: "08:00" }, false],
    [{ start: "2100", end: "08:00" }, false],
    [{ start: "ab:cd", end: "08:00" }, false],
  ])("treats %j as valid: %s", (window, valid) => {
    expect(isValidQuietHours(window)).toBe(valid);
  });
});

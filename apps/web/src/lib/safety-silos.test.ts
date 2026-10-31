import { describe, expect, it } from "vitest";
import {
  complaintMoves,
  complaintStateChip,
  complaintsShown,
  complaintTargets,
  readComplaint,
  readComplaintStep,
  readCompliment,
} from "./complaints";
import { t } from "./i18n";
import {
  readRaiseConcern,
  readSafeguardingStep,
  readSafeguardingUpdate,
  safeguardingClockChip,
  safeguardingShown,
  safeguardingStateChip,
} from "./safeguarding";
import {
  anonymousPagePath,
  caseReference,
  isReplyToken,
  nextPageHref,
  readAnonymousSpeakUp,
  readMessage,
  readRaiseSpeakUp,
  readReplyToken,
  readSpeakUpStep,
  speakUpShown,
  speakUpStateChip,
} from "./speak-up";

/** Phase 2 slice 62: the pure parts of the safeguarding, complaints and speak-up screens. */

const ID = "0199f000-0000-7000-8000-0000000000a1";
const LOCATION = "0194d000-0000-7000-8000-000000000101";
const NOW = new Date("2026-10-31T12:00:00Z");

function form(values: Record<string, string | readonly string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const v of typeof value === "string" ? [value] : value) data.append(key, v);
  }
  return data;
}
const when = (name: string, [d, m, y, h, min]: readonly string[]) => ({
  [`${name}-day`]: d ?? "",
  [`${name}-month`]: m ?? "",
  [`${name}-year`]: y ?? "",
  [`${name}-hour`]: h ?? "",
  [`${name}-minute`]: min ?? "",
});

describe("complaints", () => {
  it("is shown to holders of safety.complaint.manage only", () => {
    expect(complaintsShown(["safety.complaint.manage"])).toBe(true);
    expect(complaintsShown(["safety.incident.read"])).toBe(false);
  });

  it.each([
    ["received", "due", "clock"],
    ["acknowledged", "due", "clock"],
    ["appealed", "due", "clock"],
    ["investigating", "info", "search"],
    ["responded", "info", "search"],
    ["closed", "neutral", "circle-check"],
    ["sideways", "overdue", "triangle-alert"],
  ])("names %s as an icon and a word (%s, %s)", (state, status, icon) => {
    const chip = complaintStateChip(state, t);
    expect(chip).toMatchObject({ status, icon });
    expect(chip.label.length).toBeGreaterThan(0);
  });

  it("gives the targets still ahead, in UK dates", () => {
    const clocks = {
      acknowledgeBy: "2026-11-03",
      respondBy: "2026-11-28",
      pausedWorkingDays: 0,
      wording: "",
    };
    expect(complaintTargets({ state: "received", clocks }, t)).toEqual([
      "Acknowledge by 03/11/2026",
      "Respond by 28/11/2026",
    ]);
    expect(complaintTargets({ state: "investigating", clocks }, t)).toEqual([
      "Respond by 28/11/2026",
    ]);
    expect(complaintTargets({ state: "responded", clocks }, t)).toEqual([]);
  });

  it("offers the workflow's steps from each state", () => {
    expect(complaintMoves("received")).toContain("acknowledged");
    expect(complaintMoves("closed")).toEqual([]);
  });

  it("reads a complete complaint and refuses an incomplete one in words", () => {
    const complete = form({
      complainantName: "Pat Example",
      complainantRelationship: "family_or_friend",
      channel: "email",
      summary: "Lunch arrives cold.",
      ...when("receivedAt", ["30", "10", "2026", "09", "15"]),
      "knewOfMatterOn-day": "28",
      "knewOfMatterOn-month": "10",
      "knewOfMatterOn-year": "2026",
    });
    const read = readComplaint(complete, t, { id: ID, locationId: LOCATION, now: NOW });
    expect(read).toMatchObject({
      ok: true,
      body: { complainantName: "Pat Example", knewOfMatterOn: "2026-10-28", channel: "email" },
    });
    const empty = readComplaint(form({}), t, { id: ID, locationId: LOCATION, now: NOW });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(Object.keys(empty.errors).sort()).toEqual(
        [
          "channel",
          "complainantName",
          "complainantRelationship",
          "knewOfMatterOn",
          "receivedAt",
          "summary",
        ].sort(),
      );
    }
  });

  it("refuses knowing of the matter after it arrived", () => {
    const read = readComplaint(
      form({
        complainantName: "Pat Example",
        complainantRelationship: "family_or_friend",
        channel: "email",
        summary: "Lunch arrives cold.",
        ...when("receivedAt", ["28", "10", "2026", "09", "15"]),
        "knewOfMatterOn-day": "30",
        "knewOfMatterOn-month": "10",
        "knewOfMatterOn-year": "2026",
      }),
      t,
      { id: ID, locationId: LOCATION, now: NOW },
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors.knewOfMatterOn).toMatch(/cannot be after/);
  });

  it("refuses a response without the Ombudsman signposted and a kept copy", () => {
    const missing = readComplaintStep(
      form({ outcome: "upheld", actionsTaken: "Hot trolleys bought." }),
      t,
      { to: "responded", version: 2 },
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(Object.keys(missing.errors).sort()).toEqual(["documentId", "ombudsmanSignposted"]);
    }
    const complete = readComplaintStep(
      form({
        outcome: "upheld",
        actionsTaken: "Hot trolleys bought.",
        ombudsmanSignposted: "yes",
        documentId: ID,
      }),
      t,
      { to: "responded", version: 2 },
    );
    expect(complete).toMatchObject({ ok: true, body: { response: { ombudsmanSignposted: true } } });
  });

  it.each([
    ["closed", {}, false],
    ["closed", { reason: "Resolved." }, true],
    ["acknowledged", {}, true],
  ] as const)("reads a %s step", (to, values, ok) => {
    expect(readComplaintStep(form(values), t, { to, version: 1 }).ok).toBe(ok);
  });

  it("reads a compliment with the staff it names", () => {
    const read = readCompliment(
      form({
        fromName: "Sam Example",
        fromRelationship: "family_or_friend",
        summary: "Thank you for the birthday tea.",
        staffIds: [ID, ID, "not-an-id"],
        ...when("receivedAt", ["30", "10", "2026", "09", "15"]),
      }),
      t,
      { id: ID, locationId: LOCATION, now: NOW },
    );
    expect(read).toMatchObject({ ok: true, body: { staffIds: [ID], evidenceStatementIds: [] } });
  });
});

describe("safeguarding", () => {
  it("is shown to holders of safety.safeguarding.manage only", () => {
    expect(safeguardingShown(["safety.safeguarding.manage"])).toBe(true);
    expect(safeguardingShown(["care.plan.read"])).toBe(false);
  });

  it.each([
    ["concern", "due"],
    ["referred", "info"],
    ["closed", "neutral"],
    ["unheard_of", "overdue"],
  ])("names state %s (%s)", (state, status) => {
    expect(safeguardingStateChip(state, t).status).toBe(status);
  });

  it.each([
    ["overdue", "overdue", "circle-alert"],
    ["due", "due", "clock"],
    ["referred", "neutral", "send"],
    ["not_referred", "neutral", "circle-minus"],
  ] as const)("shows a %s clock in the API's words", (status, chipStatus, icon) => {
    expect(safeguardingClockChip({ status, wording: "Refer by 31/10/2026 12:00" }, t)).toEqual({
      status: chipStatus,
      icon,
      label: "Refer by 31/10/2026 12:00",
    });
  });

  it("raises a concern only with a kind of abuse and what happened", () => {
    expect(readRaiseConcern(form({}), t, { id: ID, personId: ID }).ok).toBe(false);
    const read = readRaiseConcern(
      form({
        abuseTypes: ["neglect", "neglect", "made_up"],
        description: "Left without water overnight.",
        protectiveMeasures: "Check water every two hours.",
      }),
      t,
      { id: ID, personId: ID },
    );
    expect(read).toMatchObject({
      ok: true,
      body: { abuseTypes: ["neglect"], protectiveMeasures: "Check water every two hours." },
    });
  });

  it("sends only the sections filled in, and says when nothing was", () => {
    const nothing = readSafeguardingUpdate(form({}), t, { version: 3, now: NOW });
    expect(nothing.ok).toBe(false);
    const referral = readSafeguardingUpdate(
      form({
        localAuthority: "Example Council",
        referralMethod: "phone",
        ...when("referredAt", ["31", "10", "2026", "10", "00"]),
      }),
      t,
      { version: 3, now: NOW },
    );
    expect(referral).toMatchObject({
      ok: true,
      body: { version: 3, referral: { localAuthority: "Example Council", method: "phone" } },
    });
    if (referral.ok) expect(referral.body.finding).toBeUndefined();
    const clearMeasures = readSafeguardingUpdate(
      form({ measuresChanged: "yes", protectiveMeasures: "  " }),
      t,
      { version: 3, now: NOW },
    );
    expect(clearMeasures).toMatchObject({ ok: true, body: { protectiveMeasures: null } });
  });

  it("asks for a reason not to refer or to close", () => {
    expect(readSafeguardingStep(form({}), t, { to: "no_referral", version: 1 }).ok).toBe(false);
    expect(readSafeguardingStep(form({}), t, { to: "referred", version: 1 }).ok).toBe(true);
  });
});

describe("speak-up", () => {
  it("is shown to every member of staff, never to a family member", () => {
    expect(speakUpShown([], false)).toBe(true);
    expect(speakUpShown(["comms.feed.read"], true)).toBe(false);
  });

  it("names states in words, and an unknown one as a warning", () => {
    expect(speakUpStateChip("received", t).status).toBe("due");
    expect(speakUpStateChip("closed", t).status).toBe("neutral");
    expect(speakUpStateChip("lost", t).status).toBe("overdue");
  });

  it("raises a named or confidential concern only", () => {
    const base = { category: "conduct", summary: "Shouting at night." };
    expect(readRaiseSpeakUp(form({ ...base, identity: "anonymous" }), t, { id: ID }).ok).toBe(
      false,
    );
    expect(
      readRaiseSpeakUp(form({ ...base, identity: "confidential" }), t, { id: ID }),
    ).toMatchObject({
      ok: true,
      body: { identity: "confidential", category: "conduct" },
    });
  });

  it("reads the public form with or without a reply code", () => {
    expect(
      readAnonymousSpeakUp(form({ category: "other", summary: "Doors propped." }), t),
    ).toMatchObject({ ok: true, body: { wantsReplies: false } });
    expect(
      readAnonymousSpeakUp(
        form({ category: "other", summary: "Doors propped.", wantsReplies: "yes" }),
        t,
      ),
    ).toMatchObject({ ok: true, body: { wantsReplies: true } });
    expect(readAnonymousSpeakUp(form({ summary: "x" }), t).ok).toBe(false);
  });

  it("accepts only a well-formed reply code, and never puts one in an address", () => {
    const token = "A".repeat(43);
    expect(isReplyToken(token)).toBe(true);
    expect(isReplyToken(`${token}=`)).toBe(false);
    expect(readReplyToken(form({ replyToken: ` ${token} ` }), t)).toEqual({
      ok: true,
      body: { replyToken: token },
    });
    expect(anonymousPagePath(ID)).toBe(`/speak-up-anonymously/${ID}`);
    expect(anonymousPagePath(ID)).not.toContain(token);
  });

  it("reads messages and the lead's steps", () => {
    expect(readMessage(form({ body: "" }), t).ok).toBe(false);
    expect(readSpeakUpStep(form({}), t, { to: "outcome_shared", version: 1 }).ok).toBe(false);
    expect(
      readSpeakUpStep(form({ reason: "Done." }), t, { to: "closed", version: 1 }),
    ).toMatchObject({
      ok: true,
      body: { reason: "Done." },
    });
  });

  it("gives each concern a short reference to tell same-day concerns apart", () => {
    expect(caseReference("0199f000-0000-7000-8000-0000000abc12")).toBe("ABC12".padStart(6, "0"));
    expect(caseReference(ID)).not.toBe(caseReference("0199f000-0000-7000-8000-0000000000a2"));
  });

  it("links the next page by the API's cursor", () => {
    expect(nextPageHref(null)).toBeNull();
    expect(nextPageHref("a/b=")).toBe("/speak-up/cases?cursor=a%2Fb%3D");
  });
});

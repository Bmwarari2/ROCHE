import {
  ALERT_REASON_CODES,
  alertSummaryCode,
  compileHandover,
  HANDOVER_ALERT_KINDS,
  HANDOVER_ITEM_KINDS,
  HANDOVER_SUMMARY_KEYS,
  type HandoverSources,
  shiftAt,
  twoShiftPattern,
} from "@harbour/domain";
import { createTranslator, type MessageKey } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import { handoverItemWords } from "./handover-summary";

/**
 * Screens gate item (a) (H-300): every summary the server compiles is worded on the phone from
 * its own catalogue, in English and Welsh, without reading the source. Invented records only.
 */

const t = (iso: string) => new Date(iso);
const PATTERN = twoShiftPattern(480, 1200);
const shift = shiftAt(t("2026-10-11T10:00:00Z"), PATTERN);
const during = { occurredAt: t("2026-10-11T09:00:00Z"), recordedAt: t("2026-10-11T09:01:00Z") };
const task = (id: string, extra: Record<string, unknown>) => ({
  id,
  personId: "p2",
  kind: "care.repositioning",
  title: "Reposition",
  status: "open" as const,
  priority: "routine" as const,
  evidenceRequired: false,
  dueAt: t("2026-10-11T12:00:00Z"),
  windowEnd: null,
  createdAt: t("2026-10-10T12:00:00Z"),
  closedAt: null,
  ...extra,
});

const sources: HandoverSources = {
  observations: [
    {
      id: "o-high",
      personId: "p1",
      chart: "vital_signs",
      news2Band: "high",
      news2Score: 7,
      refused: false,
      ...during,
    },
    {
      id: "o-medium",
      personId: "p1",
      chart: "vital_signs",
      news2Band: "medium",
      news2Score: null,
      refused: false,
      ...during,
    },
    {
      id: "o-drink",
      personId: "p3",
      chart: "fluid_intake",
      news2Band: null,
      refused: true,
      ...during,
    },
  ],
  incidents: [
    { id: "i-fall", personIds: ["p1"], type: "fall", ...during },
    { id: "i-near", personIds: [], type: "near_miss", ...during },
  ],
  bodyMapMarks: [
    {
      id: "m-1",
      personId: "p3",
      markType: "bruise",
      view: "front",
      region: "left_shin",
      side: "left",
      ...during,
    },
  ],
  notes: [
    { id: "n-fall", personId: "p4", tags: ["fall"], ...during },
    { id: "n-refusal", personId: "p4", tags: ["refusal"], ...during },
    { id: "n-flagged", personId: "p4", tags: ["handover"], ...during },
  ],
  alerts: [
    {
      id: "a-urgent",
      kind: "care.urgent_result",
      personId: "p1",
      severity: "urgent",
      createdAt: t("2026-10-11T09:02:00Z"),
      acknowledgedAt: null,
    },
  ],
  tasks: [
    task("t-overdue", {
      windowEnd: t("2026-10-11T12:30:00Z"),
      fromEarlierPlan: true,
      planAction: "Turn every two hours, left and right",
    }),
    task("t-unfinished", {
      dueAt: t("2026-10-11T18:00:00Z"),
      windowEnd: t("2026-10-11T22:00:00Z"),
    }),
    task("t-skipped", {
      status: "skipped",
      priority: "urgent",
      statusReason: "Asleep, will turn at 14:00",
      closedAt: t("2026-10-11T10:00:00Z"),
    }),
    task("t-cancelled", {
      status: "cancelled",
      evidenceRequired: true,
      statusReason: null,
      closedAt: t("2026-10-11T11:00:00Z"),
    }),
    task("t-must", {
      personId: "p3",
      kind: "care.dietitian_referral",
      title: "Refer to the dietitian",
      dueAt: t("2026-10-12T09:00:00Z"),
      createdAt: t("2026-10-11T09:05:00Z"),
    }),
  ],
};

const items = compileHandover(shift, sources, t("2026-10-11T18:30:00Z"));
const row = (sourceId: string, kind?: string) => {
  const item = items.find((i) => i.sourceId === sourceId && (!kind || i.kind === kind));
  return { kind: item?.kind ?? null, summary: JSON.stringify(item?.summary) };
};

describe("hazard HZ-018 a handover item's words on the phone, from the server's summary (gate item (a), H-300)", () => {
  it.each([
    ["i-fall", "fall", "Fall, reported as an incident"],
    ["n-fall", "fall", "Fall, written in a care note"],
    ["o-high", "news2", "NEWS2 score 7, high clinical risk"],
    ["o-medium", "news2", "NEWS2, medium clinical risk"],
    ["i-near", "incident", "Incident: a near miss"],
    ["a-urgent", "alert", "Urgent alert raised: an observation needed an urgent response"],
    ["m-1", "body_map_mark", "Body map: Bruise, left shin, left side"],
    ["n-flagged", "flagged_note", "A care note marked to include in the handover"],
    [
      "t-overdue",
      "overdue_task",
      "Overdue: Turn every two hours, left and right. From an earlier plan: check the current plan",
    ],
    ["t-unfinished", "unfinished_task", "Not done yet: Reposition"],
    ["t-must", "must_follow_up", "Follow-up after a MUST score: Refer to the dietitian"],
    ["t-skipped", "skipped_task", "Not done: Reposition. Reason: Asleep, will turn at 14:00"],
    ["t-cancelled", "skipped_task", "Cancelled: Reposition. No reason given."],
    ["o-drink", "refusal", "Refused: a drink"],
    ["n-refusal", "refusal", "Refusal, written in a care note"],
  ])("words %s (%s) as %j", (sourceId, kind, words) => {
    const item = row(sourceId, kind);
    if (kind === "body_map_mark") {
      // The area and side as this phone's body map words them.
      expect(handoverItemWords(item)).toMatch(/^Body map: Bruise/);
    } else {
      expect(handoverItemWords(item)).toBe(words);
    }
  });

  it("has an English and a Welsh catalogue entry for every summary key and every kind", () => {
    for (const locale of ["en-GB", "cy"] as const) {
      const words = createTranslator(locale);
      // Every parameter any summary takes, so each message formats in full.
      const params = {
        source: "incident",
        scored: "yes",
        score: 5,
        band: "high",
        type: "fall",
        alert: "other",
        planned: "no",
        planAction: "",
        earlierPlan: "no",
        mark: "Bruise",
        title: "Reposition",
        status: "skipped",
        hasReason: "no",
        reason: "",
        chart: "food",
      };
      for (const key of Object.values(HANDOVER_SUMMARY_KEYS)) {
        const message = words(`mobile.${key}` as MessageKey, params);
        expect(message.length).toBeGreaterThan(0);
        expect(message).not.toContain("handover.summary");
      }
      for (const kind of HANDOVER_ITEM_KINDS) {
        expect(words("mobile.handover.summary.none", { kind })).not.toBe("Handover item");
      }
    }
  });

  it.each([
    ["no summary (compiled before summaries)", null],
    ["a summary that is not JSON", "{not json"],
    ["a key this build does not know", JSON.stringify({ key: "handover.summary.new", params: {} })],
    ["a key outside the namespace", JSON.stringify({ key: "mobile.round.move", params: {} })],
    [
      "parameters that are not an object",
      JSON.stringify({ key: "handover.summary.fall", params: [] }),
    ],
  ])("words an item by its kind when it has %s, never as a raw key", (_label, summary) => {
    expect(handoverItemWords({ kind: "news2", summary })).toBe("NEWS2 raised");
    expect(handoverItemWords({ kind: null, summary })).toBe("Handover item");
  });
});

describe("hazard HZ-018 every urgent alert a summary names is worded for what it is about (#50 review round 1, clinical M2)", () => {
  const UNKNOWN = "Urgent alert raised: open the alert to see what it is about";
  const alert = (kind: string, reason: string) =>
    handoverItemWords({
      kind: "alert",
      summary: JSON.stringify({
        key: "handover.summary.alert",
        params: { alert: alertSummaryCode(kind), reason },
      }),
    });

  it.each(HANDOVER_ALERT_KINDS.filter((k) => k !== "care.urgent_result"))("%s", (kind) => {
    expect(alert(kind, "other")).not.toBe(UNKNOWN);
  });

  it.each(ALERT_REASON_CODES)("care.urgent_result raised by %s", (reason) => {
    const words = alert("care.urgent_result", reason);
    expect(words).not.toBe("Urgent alert raised: an observation needed an urgent response");
    expect(words).not.toBe(UNKNOWN);
  });

  it("words an IDDSI texture alert as one, never as a NEWS2 score", () => {
    expect(alert("care.urgent_result", "iddsi_unsafe_level")).toMatch(/texture level/);
    expect(alert("care.urgent_result", "news2_threshold")).toMatch(/NEWS2/);
  });

  it("words a kind it does not know as an alert to open", () => {
    expect(alert("some.new_kind", "other")).toBe(UNKNOWN);
  });

  it("words a NEWS2 alert by the score and band found, in the past, as published (#123 clinical review, M6)", () => {
    const words = (params: Record<string, string | number>) =>
      handoverItemWords({
        kind: "alert",
        summary: JSON.stringify({
          key: "handover.summary.alert",
          params: { alert: "care_urgent_result", reason: "news2_threshold", ...params },
        }),
      });
    expect(words({ scored: "yes", score: 7, band: "high" })).toBe(
      "Urgent alert raised: NEWS2 score 7, high clinical risk",
    );
    expect(words({ scored: "yes", score: 3, band: "low_medium" })).toBe(
      "Urgent alert raised: NEWS2 score 3, low-medium clinical risk, because a single parameter scored 3",
    );
    // Compiled before alerts carried the score.
    expect(words({})).toBe(
      "Urgent alert raised: a NEWS2 score reached the level for an urgent response",
    );
    for (const w of [words({ scored: "yes", score: 7, band: "high" }), words({})]) {
      expect(w).not.toMatch(/needs a response now/);
    }
  });

  it("words both texture alerts for food or a drink, and says they may not be safe (#123 clinical review, M5)", () => {
    for (const reason of ["iddsi_unsafe_level", "iddsi_level_not_recorded"]) {
      const words = alert("care.urgent_result", reason);
      expect(words).toMatch(/food or a drink/);
      expect(words).toMatch(/which may not be safe$/);
    }
  });
});

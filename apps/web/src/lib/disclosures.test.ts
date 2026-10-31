import type { Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  disclosureDueChip,
  disclosureStateChip,
  disclosureSteps,
  disclosuresShown,
  itemDecisionChip,
  preventionChip,
  readDecide,
  readItemDecision,
  readLogRequest,
  readPreventionReport,
  readWithdraw,
} from "./disclosures";

/**
 * A stand-in translator: these tests check states, icons and what the readers return; the words
 * themselves are checked by the catalogue tests and the journeys.
 */
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as Translator;

/** Phase 2 slice 63: the pure parts of the disclosure request screens (SAFE-016). */

const PERSON = "0194d000-0000-7000-8600-000000000001";
const SHA = "a".repeat(64);
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
  ...(h !== undefined ? { [`${name}-hour`]: h, [`${name}-minute`]: min ?? "" } : {}),
});

describe("disclosure requests", () => {
  it.each([
    [["safety.incident.manage"], true],
    [["safety.disclosure.approve"], true],
    [["safety.incident.read"], false],
  ] as const)("is shown to %j: %s", (permissions, shown) => {
    expect(disclosuresShown(permissions)).toBe(shown);
  });

  it.each([
    ["requested", "due", "clock"],
    ["prepared", "info", "file-pen"],
    ["approved", "info", "circle-check"],
    ["released", "neutral", "send"],
    ["refused", "neutral", "circle-minus"],
    ["withdrawn", "neutral", "circle-minus"],
    ["lost", "overdue", "triangle-alert"],
  ])("names state %s as an icon and a word", (state, status, icon) => {
    expect(disclosureStateChip(state, t)).toMatchObject({ status, icon });
  });

  it("says when the answer is due, overdue while still open, and nothing once done", () => {
    expect(
      disclosureDueChip({ dueAt: "2026-11-30T12:00:00Z", state: "requested" }, t, NOW)?.status,
    ).toBe("due");
    expect(
      disclosureDueChip({ dueAt: "2026-10-01T12:00:00Z", state: "prepared" }, t, NOW)?.status,
    ).toBe("overdue");
    expect(
      disclosureDueChip({ dueAt: "2026-10-01T12:00:00Z", state: "released" }, t, NOW),
    ).toBeNull();
    expect(disclosureDueChip({ dueAt: null, state: "requested" }, t, NOW)).toBeNull();
  });

  it.each([
    ["pending", "due"],
    ["disclose", "neutral"],
    ["redact", "info"],
    ["withhold", "neutral"],
    ["other", "overdue"],
  ])("names item decision %s", (decision, status) => {
    expect(itemDecisionChip(decision, t).status).toBe(status);
  });

  it.each([
    ["due", "due"],
    ["overdue", "overdue"],
    ["responded", "neutral"],
  ])("shows a Regulation 28 response %s", (state, status) => {
    expect(preventionChip({ state, responseDueOn: "2026-12-26" }, t, (d) => d).status).toBe(status);
  });

  it.each([
    [
      { state: "requested", collectedAt: null, items: { total: 0, pending: 0 } },
      ["collect", "withdraw"],
    ],
    [
      { state: "requested", collectedAt: "x", items: { total: 3, pending: 1 } },
      ["collect", "withdraw"],
    ],
    [
      { state: "requested", collectedAt: "x", items: { total: 3, pending: 0 } },
      ["collect", "prepare", "withdraw"],
    ],
    [
      { state: "prepared", collectedAt: "x", items: { total: 3, pending: 0 } },
      ["decide", "withdraw"],
    ],
    [
      { state: "approved", collectedAt: "x", items: { total: 3, pending: 0 } },
      ["release", "withdraw"],
    ],
    [{ state: "released", collectedAt: "x", items: { total: 3, pending: 0 } }, []],
  ] as const)("offers the steps in order for %j", (request, steps) => {
    expect(disclosureSteps(request)).toEqual(steps);
  });

  it("reads a logged request and refuses an incomplete one field by field", () => {
    const read = readLogRequest(
      form({
        personId: PERSON,
        type: "police",
        requesterName: "PC Example",
        requesterOrganisation: "Example Constabulary",
        statedPurpose: "An investigation into a theft.",
        ...when("receivedAt", ["30", "10", "2026", "09", "00"]),
      }),
      t,
      { now: NOW },
    );
    expect(read).toMatchObject({
      ok: true,
      body: { type: "police", requester: { organisation: "Example Constabulary" } },
    });
    if (read.ok) expect(read.body.requester.reference).toBeUndefined();
    const empty = readLogRequest(form({}), t, { now: NOW });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(Object.keys(empty.errors).sort()).toEqual(
        ["personId", "receivedAt", "requesterName", "requesterOrganisation", "type"].sort(),
      );
    }
  });

  it.each([
    [{ decision: "disclose" }, true, []],
    [{ decision: "redact" }, false, ["redactedFields"]],
    [{ decision: "redact", redactedFields: ["note", "note"] }, true, []],
    [{ decision: "withhold" }, false, ["reason"]],
    [{ decision: "withhold", reason: "Third-party information." }, true, []],
    [{}, false, ["decision"]],
  ] as const)("reads item decision %j", (values, ok, errorKeys) => {
    const read = readItemDecision(form(values), t, { contentSha256: SHA, expectedVersion: 2 });
    expect(read.ok).toBe(ok);
    if (!read.ok) expect(Object.keys(read.errors)).toEqual(errorKeys);
  });

  it("sends redacted fields only when redacting, with the record's hash and version", () => {
    const read = readItemDecision(
      form({ decision: "redact", redactedFields: ["note", "note", "summary"] }),
      t,
      { contentSha256: SHA, expectedVersion: 4 },
    );
    expect(read).toEqual({
      ok: true,
      body: {
        decision: "redact",
        redactedFields: ["note", "summary"],
        reason: null,
        contentSha256: SHA,
        expectedVersion: 4,
      },
    });
    const disclose = readItemDecision(form({ decision: "disclose", redactedFields: ["note"] }), t, {
      contentSha256: SHA,
      expectedVersion: 4,
    });
    expect(disclose.ok && disclose.body.redactedFields).toEqual([]);
  });

  it("needs a reason to refuse, never to approve", () => {
    expect(readDecide(form({ decision: "approve" }), t, { expectedVersion: 3 }).ok).toBe(true);
    expect(readDecide(form({ decision: "refuse" }), t, { expectedVersion: 3 }).ok).toBe(false);
    expect(
      readDecide(form({ decision: "refuse", reason: "Not necessary." }), t, { expectedVersion: 3 })
        .ok,
    ).toBe(true);
    expect(readDecide(form({}), t, { expectedVersion: 3 }).ok).toBe(false);
  });

  it("needs a reason to withdraw", () => {
    expect(readWithdraw(form({}), t, { expectedVersion: 1 }).ok).toBe(false);
    expect(readWithdraw(form({ reason: "Asked in error." }), t, { expectedVersion: 1 }).ok).toBe(
      true,
    );
  });

  it("reads a Regulation 28 report, with the response optional but never before it", () => {
    const only = readPreventionReport(form(when("reportOn", ["01", "10", "2026"])), t, {
      expectedVersion: 1,
    });
    expect(only).toMatchObject({ ok: true, body: { reportOn: "2026-10-01", respondedOn: null } });
    const backwards = readPreventionReport(
      form({
        ...when("reportOn", ["10", "10", "2026"]),
        ...when("respondedOn", ["01", "10", "2026"]),
      }),
      t,
      { expectedVersion: 1 },
    );
    expect(backwards.ok).toBe(false);
    if (!backwards.ok) expect(Object.keys(backwards.errors)).toEqual(["respondedOn"]);
  });
});

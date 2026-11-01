import type { ShredRequestItem } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  memberName,
  openRequest,
  readShredApproval,
  readShredRefusal,
  readShredRequest,
  SHRED_CONFIRM_WORD,
  shredActions,
  shredChip,
  shredState,
  signatureChip,
} from "./shred";

/** The whole-organisation shred screens (PLAT-012 part 2; platform.md rules 7 to 11). */

const EXPORT = "0194d000-0000-7000-8000-0000000000e1";
const ME = "0194d000-0000-7000-8000-0000000000a1";
const OTHER = "0194d000-0000-7000-8000-0000000000a2";
const form = (values: Record<string, string>) => ({
  get: (name: string) => values[name] ?? null,
  getAll: (name: string) => (values[name] === undefined ? [] : [values[name]]),
});
const request = (over: Partial<ShredRequestItem> = {}): ShredRequestItem => ({
  id: "0194d000-0000-7000-8000-0000000000f1",
  status: "pending",
  reason: "The contract ended on 31/10/2026 and the export was taken.",
  exportId: EXPORT,
  requestedBy: ME,
  requestedByName: "Ada Example",
  requestedAt: "2026-10-31T12:00:00Z",
  expiresAt: "2026-11-07T12:00:00Z",
  lapsed: false,
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  decisionReason: null,
  certificateId: null,
  ...over,
});
describe("shred states, each as an icon and a word", () => {
  it.each([
    ["pending", false, "pending", "Waiting for approval"],
    ["pending", true, "lapsed", "Lapsed"],
    ["shredding", false, "shredding", "Shredding"],
    ["approved", false, "approved", "Shredded"],
    ["refused", false, "refused", "Refused"],
    ["cancelled", false, "cancelled", "Cancelled"],
  ] as const)("shows %s (lapsed %s) as %s: %s", (status, lapsed, state, word) => {
    expect(shredState({ status, lapsed })).toBe(state);
    const chip = shredChip(state, t);
    expect(chip.label).toBe(word);
    expect(chip.icon).toBeTruthy();
  });

  it.each([
    [true, "Signature checked", "done"],
    [false, "Signature does not match", "overdue"],
    [null, "Not signed", "notRecorded"],
  ] as const)("shows a signature check of %s as %s", (valid, word, status) => {
    expect(signatureChip(valid, t)).toMatchObject({ label: word, status });
  });
});

describe("what a holder may do", () => {
  it.each([
    [
      "another's fresh request",
      { requestedBy: OTHER },
      { decide: true, cancel: false, withdraw: false },
    ],
    ["their own fresh request", {}, { decide: false, cancel: true, withdraw: false }],
    [
      "another's lapsed request",
      { requestedBy: OTHER, lapsed: true },
      { decide: false, cancel: false, withdraw: true },
    ],
    [
      "their own lapsed request",
      { lapsed: true },
      { decide: false, cancel: true, withdraw: false },
    ],
    [
      "a refused request",
      { requestedBy: OTHER, status: "refused" as const },
      { decide: false, cancel: false, withdraw: false },
    ],
    [
      "a shred under way",
      { requestedBy: OTHER, status: "shredding" as const },
      { decide: false, cancel: false, withdraw: false },
    ],
  ])("for %s", (_name, over, expected) => {
    expect(shredActions(request(over), ME)).toEqual(expected);
  });

  it("finds the open request: waiting and fresh, or under way", () => {
    expect(openRequest([request({ lapsed: true }), request({ status: "refused" })])).toBeNull();
    expect(openRequest([request({ status: "shredding" })])?.status).toBe("shredding");
    expect(openRequest([request()])?.status).toBe("pending");
  });

  it("names a member the API could not name as a former member", () => {
    expect(memberName(null, t)).toBe("A former member");
    expect(memberName("Ada Example", t)).toBe("Ada Example");
  });
});

describe("reading the forms", () => {
  const offered = new Set([EXPORT]);
  const reason = "The contract ended on 31/10/2026 and the export was taken.";

  it("asks for an offered export, a reason of 20 characters or more and the acknowledgement", () => {
    expect(
      readShredRequest(form({ exportId: EXPORT, reason, irreversible: "yes" }), t, offered),
    ).toEqual({
      ok: true,
      body: { exportId: EXPORT, reason },
    });
    const read = readShredRequest(form({ exportId: "other", reason: "Leaving" }), t, offered);
    expect(read).toMatchObject({
      ok: false,
      errors: {
        exportId: expect.any(String),
        reason: expect.any(String),
        irreversible: expect.any(String),
      },
    });
  });

  it("approves only with the word typed, in any case, and the acknowledgement", () => {
    expect(
      readShredApproval(form({ confirmWord: SHRED_CONFIRM_WORD, irreversible: "yes" }), t),
    ).toEqual({ ok: true });
    expect(readShredApproval(form({ confirmWord: "SHRED", irreversible: "yes" }), t)).toEqual({
      ok: true,
    });
    for (const word of ["shed", "shred it", ""]) {
      expect(readShredApproval(form({ confirmWord: word, irreversible: "yes" }), t)).toMatchObject({
        ok: false,
        errors: { confirmWord: expect.any(String) },
      });
    }
    expect(readShredApproval(form({ confirmWord: SHRED_CONFIRM_WORD }), t)).toMatchObject({
      ok: false,
      errors: { irreversible: expect.any(String) },
    });
  });

  it("refuses with a reason of 10 to 500 characters", () => {
    expect(readShredRefusal(form({ reason: "Not agreed by the board" }), t)).toEqual({
      ok: true,
      reason: "Not agreed by the board",
    });
    for (const short of ["", "No", "x".repeat(501)]) {
      expect(readShredRefusal(form({ reason: short }), t).ok).toBe(false);
    }
  });
});

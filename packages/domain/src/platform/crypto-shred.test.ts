import { describe, expect, it } from "vitest";
import {
  backupsExpireAt,
  canonicalJson,
  certificateBody,
  checkShredApproval,
  checkShredRefusal,
  checkShredRequest,
  keysDestroyedAt,
  SHRED_REASON_MIN,
  SHRED_REFUSAL_REASON_MAX,
  SHRED_REFUSAL_REASON_MIN,
  SHRED_REQUEST_EXPIRY_DAYS,
  shredExportUsable,
  shredRequestExpiresAt,
} from "./crypto-shred";

/** Per-organisation crypto-shredding (PLAT-012, ADR-0109): table-driven. */

const REASON = "Contract ended 31/10/2026; export taken and acknowledged.";
const okRequest = {
  stepUpFresh: true,
  reason: REASON,
  exportDownloaded: true,
  activeHolds: 0,
  openRequests: 0,
};

describe("checkShredRequest", () => {
  it("accepts a reasoned request after the export, with step-up and no holds", () => {
    expect(checkShredRequest(okRequest)).toEqual({ ok: true });
  });

  it.each([
    ["no fresh step-up", { stepUpFresh: false }, "step_up_required"],
    ["a short reason", { reason: "x".repeat(SHRED_REASON_MIN - 1) }, "reason_too_short"],
    ["a blank reason padded with spaces", { reason: `   ${"x".repeat(5)}   ` }, "reason_too_short"],
    ["no downloaded export", { exportDownloaded: false }, "export_not_downloaded"],
    ["an active legal hold", { activeHolds: 1 }, "legal_hold_active"],
    ["one already open", { openRequests: 1 }, "already_pending"],
  ] as const)("refuses %s", (_case, change, problem) => {
    const verdict = checkShredRequest({ ...okRequest, ...change });
    expect(verdict).toMatchObject({ ok: false, problem });
    if (!verdict.ok) expect(verdict.message).not.toMatch(/undefined/);
  });
});

const NOW = new Date("2026-10-31T12:00:00Z");
const DAY = 86_400_000;
const okApproval = {
  stepUpFresh: true,
  status: "pending",
  requestedBy: "member-a",
  requestedAt: new Date(NOW.getTime() - DAY),
  approverId: "member-b",
  requesterEligible: true,
  exportDownloaded: true,
  activeHolds: 0,
  now: NOW,
};

describe("checkShredApproval", () => {
  it("accepts a second person with step-up", () => {
    expect(checkShredApproval(okApproval)).toEqual({ ok: true });
  });

  it.each([
    ["no fresh step-up", { stepUpFresh: false }, "step_up_required"],
    ["the requester themself", { approverId: "member-a" }, "same_person"],
    ["an approved request", { status: "approved" }, "not_pending"],
    ["a cancelled request", { status: "cancelled" }, "not_pending"],
    ["one already shredding", { status: "shredding" }, "not_pending"],
    ["an active legal hold", { activeHolds: 2 }, "legal_hold_active"],
    [
      "a request older than the expiry",
      { requestedAt: new Date(NOW.getTime() - SHRED_REQUEST_EXPIRY_DAYS * DAY) },
      "expired",
    ],
    [
      "a requester who left or lost the permission",
      { requesterEligible: false },
      "requester_ineligible",
    ],
    ["an export no longer downloaded", { exportDownloaded: false }, "export_not_downloaded"],
  ] as const)("refuses %s", (_case, change, problem) => {
    expect(checkShredApproval({ ...okApproval, ...change })).toMatchObject({ ok: false, problem });
  });

  it("accepts a request just inside the expiry", () => {
    const requestedAt = new Date(NOW.getTime() - SHRED_REQUEST_EXPIRY_DAYS * DAY + 1000);
    expect(checkShredApproval({ ...okApproval, requestedAt })).toEqual({ ok: true });
  });
});

describe("checkShredRefusal (PLAT-012 part 2)", () => {
  const at = new Date("2026-10-31T12:00:00Z");
  const ok = {
    stepUpFresh: true,
    status: "pending",
    requestedBy: "a",
    requestedAt: at,
    refuserId: "b",
    reason: "Not agreed by the board yet",
    now: new Date(at.getTime() + 86_400_000),
  };
  it("accepts a second person with step-up and a reason, while fresh", () => {
    expect(checkShredRefusal(ok)).toEqual({ ok: true });
  });
  it.each([
    ["no step-up", { stepUpFresh: false }, "step_up_required"],
    ["already decided", { status: "shredding" }, "not_pending"],
    ["the requester", { refuserId: "a" }, "same_person"],
    ["lapsed", { now: new Date(at.getTime() + SHRED_REQUEST_EXPIRY_DAYS * 86_400_000) }, "expired"],
    [
      "a short reason",
      { reason: " ".repeat(20) + "x".repeat(SHRED_REFUSAL_REASON_MIN - 1) },
      "reason_too_short",
    ],
    ["a long reason", { reason: "x".repeat(SHRED_REFUSAL_REASON_MAX + 1) }, "reason_too_short"],
    // Five characters outside the Basic Multilingual Plane are ten UTF-16 units but five characters.
    ["five astral characters", { reason: "\u{1D49C}".repeat(5) }, "reason_too_short"],
  ] as const)("refuses %s", (_name, change, problem) => {
    const verdict = checkShredRefusal({ ...ok, ...change });
    expect(verdict).toMatchObject({ ok: false, problem });
  });
  it("lapses exactly the expiry after the request", () => {
    expect(shredRequestExpiresAt(at).toISOString()).toBe("2026-11-07T12:00:00.000Z");
  });
});

describe("shredExportUsable", () => {
  const base = { kind: "full", downloadedAt: new Date(NOW.getTime() - DAY) };
  it.each([
    ["a full export downloaded yesterday", base, true],
    ["one never downloaded", { ...base, downloadedAt: null }, false],
    ["a changes-since export", { ...base, kind: "changes_since" }, false],
    [
      "one downloaded 31 days ago",
      { ...base, downloadedAt: new Date(NOW.getTime() - 31 * DAY) },
      false,
    ],
  ] as const)("%s: %s", (_case, row, usable) => {
    expect(shredExportUsable(row, NOW)).toBe(usable);
  });
});

describe("certificate body", () => {
  const input = {
    id: "0194d000-0000-7000-8000-00000000c001",
    tenantId: "0194d000-0000-7000-8000-000000000001",
    recordClass: "tenant_exit",
    subjectType: "tenant",
    subjectIds: ["0194d000-0000-7000-8000-000000000001"],
    recordCount: 1,
    retentionRule: { source: "DPA clause 9" },
    reason: REASON,
    method: "kms_key_destroy:local",
    executedAt: new Date("2026-10-31T12:00:00Z"),
    requestedBy: "member-a",
    approvedBy: "member-b",
    keyVersions: [
      { name: "tenant-x/versions/2", destroyAt: "2026-11-30T12:00:00Z" },
      { name: "tenant-x/versions/1", destroyAt: "2026-11-30T12:00:01Z" },
    ],
    backupsExpireAt: new Date("2026-11-07T12:00:00Z"),
    signatureKey: "local/certificate-signing/1",
    signatureAlgorithm: "ED25519",
  };

  it("states every field, sorted, so the same certificate always hashes the same", () => {
    const body = JSON.parse(certificateBody(input));
    expect(body).toMatchObject({
      format: "harbour.destruction-certificate.v1",
      requestedBy: "member-a",
      approvedBy: "member-b",
      keysDestroyedAt: "2026-11-30T12:00:01.000Z",
      backupsExpireAt: "2026-11-07T12:00:00.000Z",
      signatureKey: "local/certificate-signing/1",
      signatureAlgorithm: "ED25519",
    });
    expect(body.keyVersions.map((k: { name: string }) => k.name)).toEqual([
      "tenant-x/versions/1",
      "tenant-x/versions/2",
    ]);
    const reordered = { ...input, keyVersions: [...input.keyVersions].reverse() };
    expect(certificateBody(reordered)).toBe(certificateBody(input));
  });

  it("has no key destroy time when no key was destroyed", () => {
    const body = JSON.parse(certificateBody({ ...input, keyVersions: [] }));
    expect(body.keysDestroyedAt).toBeNull();
    expect(keysDestroyedAt([])).toBeNull();
  });

  it.each([
    [{ b: 1, a: [3, { d: null, c: "x" }] }, '{"a":[3,{"c":"x","d":null}],"b":1}'],
    [{ skip: undefined, k: true }, '{"k":true}'],
    ["text", '"text"'],
  ])("canonicalJson(%j)", (value, json) => {
    expect(canonicalJson(value)).toBe(json);
  });

  it("dates backup expiry by the point-in-time recovery window", () => {
    expect(backupsExpireAt(new Date("2026-10-31T00:00:00Z"), 7).toISOString()).toBe(
      "2026-11-07T00:00:00.000Z",
    );
  });
});

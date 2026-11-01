import { describe, expect, it } from "vitest";
import { readRateTable } from "../../test/rate-table";
import { checkWorkflowTransition } from "../platform/workflow";
import { addUkDays } from "../shared/time";
import {
  ahraDueAt,
  DISCLOSURE_TYPES,
  DISCLOSURE_WORKFLOW,
  type DisclosureRequestView,
  disclosurePackStorageKey,
  disclosurePrepareProblems,
  legalBasis,
} from "./disclosure";
import { resolveSafetyPhase2Rates } from "./phase2-rates";

const rates = resolveSafetyPhase2Rates(readRateTable(), "england", "2026-10-31", null);
const approver = new Set(["safety.disclosure.approve", "safety.incident.manage"]);

describe("disclosure requests (safety.md Phase 2 rule 6)", () => {
  it("names a legal basis for every type", () => {
    for (const type of Object.keys(DISCLOSURE_TYPES) as (keyof typeof DISCLOSURE_TYPES)[]) {
      expect(legalBasis(type).length, type).toBeGreaterThan(10);
    }
    expect(legalBasis("police")).toContain("Schedule 2");
  });

  it("is approved only by someone other than the requester", () => {
    const approve = (actorId: string) =>
      checkWorkflowTransition(
        DISCLOSURE_WORKFLOW,
        { state: "prepared", createdBy: "requester" },
        {
          to: "approved",
          actorId,
          permissions: approver,
          stepUpFresh: false,
        },
      );
    expect(approve("requester")).toMatchObject({ ok: false, problem: "separation_of_duties" });
    expect(approve("manager").ok).toBe(true);
  });

  it("is never released before approval, and a refusal needs a reason", () => {
    const go = (
      state: "requested" | "prepared" | "approved",
      to: "released" | "refused",
      reason: string | null = null,
    ) =>
      checkWorkflowTransition(
        DISCLOSURE_WORKFLOW,
        { state, createdBy: "requester" },
        {
          to,
          actorId: "manager",
          permissions: approver,
          reason,
          stepUpFresh: false,
        },
      ).ok;
    expect(go("prepared", "released")).toBe(false);
    expect(go("approved", "released")).toBe(true);
    expect(go("prepared", "refused")).toBe(false);
    expect(go("prepared", "refused", "No lawful basis was given")).toBe(true);
  });

  it.each<[string, DisclosureRequestView, number]>([
    [
      "an empty request",
      { type: "police", requester: null, statedPurpose: null, itemsDocumentIds: [] },
      3,
    ],
    [
      "a police request without its purpose",
      {
        type: "police",
        requester: { name: "PC Example", organisation: "Example Police" },
        statedPurpose: null,
        itemsDocumentIds: ["d1"],
      },
      1,
    ],
    [
      "a coroner's request with what it needs",
      {
        type: "coroner",
        requester: { name: "HM Coroner", organisation: "Example Coroner Area" },
        statedPurpose: null,
        itemsDocumentIds: ["d1"],
      },
      0,
    ],
  ])("prepares %s with %i problems", (_, request, count) => {
    expect(disclosurePrepareProblems(request)).toHaveLength(count);
  });

  it("answers an Access to Health Records request in the shorter time when the records are recent", () => {
    const received = new Date("2026-10-26T10:00:00Z");
    const recent = ahraDueAt(
      received,
      addUkDays(received, -(rates.ahraRecentRecordDays - 1)),
      rates,
    );
    expect(recent).toEqual({
      dueAt: addUkDays(received, rates.ahraRecentRecordResponseDays - 1), // "beginning with" the day received
      recent: true,
    });
    const old = ahraDueAt(received, addUkDays(received, -(rates.ahraRecentRecordDays + 1)), rates);
    expect(old).toEqual({ dueAt: addUkDays(received, rates.ahraResponseDays - 1), recent: false });
  });
});

describe("disclosurePackStorageKey (rule 42)", () => {
  const t = "0194d000-0000-7000-8000-000000000001";
  const r = "0194d000-0000-7000-8000-000000000002";
  const p = "0194d000-0000-7000-8000-000000000003";
  it("is built from UUIDs only", () => {
    expect(disclosurePackStorageKey(t, r, p)).toBe(`tenants/${t}/disclosures/${r}/${p}.json`);
    expect(() => disclosurePackStorageKey(t, "../x", p)).toThrow(RangeError);
    expect(() => disclosurePackStorageKey("Ada", r, p)).toThrow(RangeError);
  });
});

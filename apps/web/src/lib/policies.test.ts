import type { PolicyItem } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  inForceFor,
  policiesManaged,
  readDraft,
  readNewPolicy,
  reviewChip,
  signChip,
  versionStateChip,
} from "./policies";

const t = createTranslator("en-GB");

const form = (entries: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const value = entries[name];
    return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  },
  getAll: (name: string) => {
    const value = entries[name];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  },
});

type Version = PolicyItem["versions"][number];
const version = (over: Partial<Version>): Version => ({
  id: "v1",
  version: 1,
  versionNumber: 1,
  state: "published",
  change: "major",
  changeSummary: "First version",
  body: "Text",
  documentId: null,
  roles: ["care_worker"],
  reviewDueOn: "2027-10-31",
  reviewStatus: "current",
  authorId: "a",
  publishedBy: "b",
  publishedOn: "2026-10-31",
  supersededAt: null,
  supersededBy: null,
  retiredReason: null,
  ...over,
});

describe("statuses in words with an icon", () => {
  it.each([
    ["draft", "Draft"],
    ["published", "In force"],
    ["superseded", "Superseded"],
    ["retired", "Retired"],
  ] as const)("a %s version", (state, label) => {
    expect(versionStateChip(state, t).label).toBe(label);
  });

  it.each([
    ["current", "Review in date", "done"],
    ["due_soon", "Review due soon", "due"],
    ["overdue", "Review overdue", "overdue"],
    ["no_review_date", "No review date", "neutral"],
  ] as const)("a review %s", (status, label, look) => {
    expect(reviewChip(status, t)).toMatchObject({ label, status: look });
  });

  it("says whether the reader must still read and sign", () => {
    expect(signChip({ mustSign: true, signed: false }, t)?.label).toBe("To read and sign");
    expect(signChip({ mustSign: true, signed: true }, t)?.label).toBe("Signed by you");
    expect(signChip({ mustSign: false, signed: false }, t)).toBeNull();
  });

  it("only managers manage", () => {
    expect(policiesManaged(["quality.policy.manage"])).toBe(true);
    expect(policiesManaged(["care.note.write"])).toBe(false);
  });
});

describe("hazard HZ-128 a superseded version names the version in force", () => {
  it("finds the version in force for a superseded one, and none for others", () => {
    const now = version({ id: "v2", versionNumber: 2 });
    const old = version({ state: "superseded", supersededBy: "v2" });
    expect(inForceFor({ versions: [now, old] }, old)?.versionNumber).toBe(2);
    expect(inForceFor({ versions: [now, old] }, now)).toBeNull();
  });
});

describe("reading the forms", () => {
  it("reads a draft with its roles and optional review date", () => {
    expect(
      readDraft(
        form({
          change: "minor",
          changeSummary: " Updated contacts ",
          body: "Policy text",
          roles: ["care_worker", "made_up"],
        }),
        [],
        t,
      ),
    ).toEqual({
      ok: true,
      draft: {
        change: "minor",
        changeSummary: "Updated contacts",
        body: "Policy text",
        documentId: null,
        roles: ["care_worker"],
        reviewDueOn: null,
      },
    });
  });

  it("asks for the kind of change, a summary and some content, at their fields", () => {
    const read = readDraft(form({}), [], t);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(Object.keys(read.errors).sort()).toEqual(["body", "change", "changeSummary"]);
  });

  it("takes an organisation document instead of text, and refuses one not offered", () => {
    const ok = readDraft(
      form({ change: "major", changeSummary: "New", documentId: "d1" }),
      ["d1"],
      t,
    );
    expect(ok.ok && ok.draft.documentId).toBe("d1");
    const bad = readDraft(
      form({ change: "major", changeSummary: "New", documentId: "d9" }),
      ["d1"],
      t,
    );
    expect(bad.ok).toBe(false);
  });

  it("reads a new policy's short name, title and second reviewer", () => {
    expect(
      readNewPolicy(
        form({ policyKey: "safeguarding", title: "Safeguarding", secondReviewer: "yes" }),
        t,
      ),
    ).toEqual({
      ok: true,
      policyKey: "safeguarding",
      title: "Safeguarding",
      requireSecondReviewer: true,
    });
    const bad = readNewPolicy(form({ policyKey: "Safe guarding", title: "S" }), t);
    expect(bad.ok).toBe(false);
  });
});

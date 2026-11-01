import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import {
  destroyOutcome,
  methodWords,
  readDestroy,
  readPlaceHold,
  readRelease,
  retentionShown,
  splitHolds,
} from "./retention";

const PERSON = "0194d000-0000-7000-8600-000000000153";
const DOC_A = "0194d000-0000-7000-8000-00000000000a";
const DOC_B = "0194d000-0000-7000-8000-00000000000b";
const form = (values: Record<string, string | string[]>) => ({
  get: (name: string) => {
    const v = values[name];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  },
  getAll: (name: string) => {
    const v = values[name];
    return Array.isArray(v) ? v : v === undefined ? [] : [v];
  },
});

describe("records retention (PLAT-012)", () => {
  it("is shown only to holders of platform.retention.manage", () => {
    expect(retentionShown(["platform.retention.manage"])).toBe(true);
    expect(retentionShown(["platform.document.manage"])).toBe(false);
  });

  it("lists holds in force, newest first, apart from released ones", () => {
    const hold = (id: string, placedAt: string, releasedAt: string | null = null) => ({
      id,
      personId: null,
      subjectType: "document",
      subjectId: DOC_A,
      reason: "Coroner has asked for it",
      placedAt,
      releasedAt,
      releaseReason: null,
      version: 1,
    });
    const { inForce, released } = splitHolds([
      hold("old", "2026-01-01T00:00:00Z"),
      hold("gone", "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
      hold("new", "2026-04-01T00:00:00Z"),
    ]);
    expect(inForce.map((h) => h.id)).toEqual(["new", "old"]);
    expect(released.map((h) => h.id)).toEqual(["gone"]);
  });

  it("places a hold on a person or on one record, with a reason of 10 or more characters", () => {
    expect(
      readPlaceHold(
        form({ target: "person", personId: PERSON, reason: "Claim received from family" }),
        t,
      ),
    ).toEqual({ ok: true, body: { personId: PERSON, reason: "Claim received from family" } });
    expect(
      readPlaceHold(
        form({
          target: "record",
          subjectType: "document",
          subjectId: DOC_A.toUpperCase(),
          reason: "Inquest pending",
        }),
        t,
      ),
    ).toEqual({
      ok: true,
      body: { subjectType: "document", subjectId: DOC_A, reason: "Inquest pending" },
    });
    const refused = readPlaceHold(
      form({ target: "record", subjectType: "Doc!", reason: "short" }),
      t,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(Object.keys(refused.errors).sort()).toEqual(["reason", "subjectId", "subjectType"]);
    expect(readPlaceHold(form({ reason: "A long enough reason" }), t)).toMatchObject({
      ok: false,
      errors: { personId: expect.any(String) },
    });
  });

  it("releases a hold only with a reason", () => {
    expect(readRelease(form({ reason: "too short" }), t).ok).toBe(false);
    expect(readRelease(form({ reason: "Inquest concluded" }), t)).toEqual({
      ok: true,
      reason: "Inquest concluded",
    });
  });

  it("destroys nothing without a document, a reason and the acknowledgement that it cannot be undone", () => {
    const offered = new Set([DOC_A, DOC_B]);
    const none = readDestroy(form({}), t, offered);
    expect(none.ok).toBe(false);
    if (!none.ok)
      expect(Object.keys(none.errors).sort()).toEqual(["documentId", "irreversible", "reason"]);
    const noAck = readDestroy(
      form({ documentId: [DOC_A], reason: "Annual records review" }),
      t,
      offered,
    );
    expect(noAck).toMatchObject({ ok: false, errors: { irreversible: expect.any(String) } });
    expect(
      readDestroy(
        form({
          documentId: [DOC_A, DOC_A, DOC_B],
          reason: "Annual records review",
          irreversible: "yes",
        }),
        t,
        offered,
      ),
    ).toEqual({ ok: true, documentIds: [DOC_A, DOC_B], reason: "Annual records review" });
  });

  it("never sends an id the page did not offer (a held record is never offered)", () => {
    const read = readDestroy(
      form({ documentId: [PERSON], reason: "Annual records review", irreversible: "yes" }),
      t,
      new Set([DOC_A]),
    );
    expect(read).toMatchObject({ ok: false, errors: { documentId: expect.any(String) } });
  });

  it("counts what was destroyed and skipped", () => {
    expect(
      destroyOutcome({ certificates: [{ recordCount: 2 }, { recordCount: 1 }], skipped: [DOC_B] }),
    ).toEqual({ destroyed: 3, skipped: 1, certificates: 2 });
    expect(t("retention.done.destroyed", { destroyed: 1, skipped: 1, certificates: 1 })).toBe(
      "1 document destroyed. 1 was not destroyed: it is under a legal hold or no longer due. 1 destruction certificate issued.",
    );
  });

  it("says the destruction method in words", () => {
    expect(methodWords("storage_delete_all_versions:gcs", t)).toBe(
      "Every stored version deleted (gcs)",
    );
    expect(methodWords("something_else", t)).toBe("something_else");
  });
});

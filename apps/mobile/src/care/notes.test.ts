import { CreateCareNote } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import { toCareUpload } from "../sync/care-upload";
import { CORRECTION_REASON_LIMITS, type EntryContext } from "./entries";
import { checkNote, NOTE_BODY_MAX, type NoteDraft } from "./notes";

const NOW = new Date("2026-10-11T10:00:00Z");
const context: EntryContext = {
  tenantId: "00000000-0000-4000-8000-0000000000a1",
  personId: "00000000-0000-4000-8000-0000000000b1",
  locationId: "00000000-0000-4000-8000-0000000000c1",
  userId: "00000000-0000-4000-8000-0000000000d1",
  newId: () => "0199d000-0000-7000-8000-000000000001",
};

const draft = (overrides: Partial<NoteDraft> = {}): NoteDraft => ({
  category: "personal_care",
  body: "  Helped Ada with a wash. Skin on heels intact.  ",
  tags: [],
  when: { kind: "now" },
  correction: null,
  ...overrides,
});

/** What the upload would send for a row, checked against the API's own schema. */
function uploadBody(row: Record<string, unknown>) {
  const request = toCareUpload({ op: "PUT", table: "care_note", id: String(row.id), opData: row });
  if (request.kind !== "request") throw new Error(request.message);
  return request.body;
}

describe("writing a note offline", () => {
  it("stores the note with a device id, both clocks and no server time yet", () => {
    const result = checkNote(draft(), context, NOW);
    expect(result.ok && result.row).toMatchObject({
      id: "0199d000-0000-7000-8000-000000000001",
      tenant_id: context.tenantId,
      person_id: context.personId,
      category: "personal_care",
      body: "Helped Ada with a wash. Skin on heels intact.",
      tags: "[]",
      occurred_at: "2026-10-11T10:00:00.000Z",
      device_time: "2026-10-11T10:00:00.000Z",
      recorded_at: null,
      supersedes_id: null,
    });
  });

  it("hazard HZ-029 names the round's task it is recorded for, and the upload sends it", () => {
    const task = "0199d000-0000-7000-8000-0000000000a1";
    const result = checkNote(draft(), { ...context, taskId: task }, NOW);
    expect(result.ok && result.row.task_id).toBe(task);
    expect(result.ok && CreateCareNote.parse(uploadBody(result.row)).taskId).toBe(task);
    const without = checkNote(draft(), context, NOW);
    expect(without.ok && "task_id" in without.row).toBe(false);
  });

  it("builds an upload the API's CreateCareNote schema accepts", () => {
    const result = checkNote(draft({ tags: ["fall", "refusal"] }), context, NOW);
    if (!result.ok) throw new Error("expected a valid note");
    expect(CreateCareNote.safeParse(uploadBody(result.row)).success).toBe(true);
  });

  it("hazard HZ-017 a correction keeps the original's event time by default (C4)", () => {
    const correction = {
      supersedesId: "0199d000-0000-7000-8000-0000000000aa",
      reason: "Wrong room",
    };
    const result = checkNote(
      draft({ correction, when: { kind: "original", at: "2026-10-10T21:05:00.000000Z" } }),
      context,
      NOW,
    );
    expect(result.ok && result.row).toMatchObject({
      occurred_at: "2026-10-10T21:05:00.000Z",
      device_time: "2026-10-11T10:00:00.000Z",
    });
  });

  it("hazard HZ-010 refuses a time still to come today rather than dating it yesterday", () => {
    const result = checkNote(draft({ when: { kind: "earlier", time: "23:45" } }), context, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.when?.key).toBe("mobile.when.future");
  });

  it("hazard HZ-017 dates a note yesterday only when the carer chooses yesterday (C4)", () => {
    const result = checkNote(
      draft({ when: { kind: "earlier", time: "23:45", daysAgo: 1 } }),
      context,
      NOW,
    );
    expect(result.ok && result.row.occurred_at).toBe("2026-10-10T22:45:00.000Z");
  });

  it("hazard HZ-010 takes the tenant's clock tolerance from the entry context", () => {
    // NOW is 11/10/2026 at 10:00 UTC (11:00 BST); 11:03 is within a 5-minute tolerance only.
    const typed = draft({ when: { kind: "earlier", time: "11:03" } });
    expect(checkNote(typed, context, NOW).ok).toBe(false);
    expect(checkNote(typed, { ...context, clockToleranceMinutes: 5 }, NOW).ok).toBe(true);
  });

  it("keeps only tags from the handover vocabulary", () => {
    const result = checkNote(draft({ tags: ["fall", "made_up"] }), context, NOW);
    expect(result.ok && result.row.tags).toBe('["fall"]');
  });

  it.each([
    [{ category: null }, "category", "mobile.form.choose"],
    [{ body: "   " }, "body", "mobile.note.bodyRequired"],
    [{ body: "x".repeat(NOTE_BODY_MAX + 1) }, "body", "mobile.note.bodyTooLong"],
    [{ when: { kind: "earlier", time: "12:00", daysAgo: 0 } }, "when", "mobile.when.future"],
    [
      { when: { kind: "earlier", time: "12:00", daysAgo: 30 } },
      "when",
      "mobile.when.outsideWindow",
    ],
    [{ when: { kind: "earlier", time: "noon" } }, "when", "mobile.when.invalid"],
  ] as const)("refuses %j with a message for %s", (change, field, key) => {
    const result = checkNote(draft(change as Partial<NoteDraft>), context, NOW);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[field]?.key).toBe(key);
  });

  it("matches the API's limits", () => {
    expect(
      CreateCareNote.safeParse({ ...validBody(), body: "x".repeat(NOTE_BODY_MAX) }).success,
    ).toBe(true);
    expect(
      CreateCareNote.safeParse({ ...validBody(), body: "x".repeat(NOTE_BODY_MAX + 1) }).success,
    ).toBe(false);
    const reason = (n: number) => ({
      ...validBody(),
      supersedesId: context.personId,
      correctionReason: "r".repeat(n),
    });
    expect(CreateCareNote.safeParse(reason(CORRECTION_REASON_LIMITS.min)).success).toBe(true);
    expect(CreateCareNote.safeParse(reason(CORRECTION_REASON_LIMITS.min - 1)).success).toBe(false);
    expect(CreateCareNote.safeParse(reason(CORRECTION_REASON_LIMITS.max)).success).toBe(true);
    expect(CreateCareNote.safeParse(reason(CORRECTION_REASON_LIMITS.max + 1)).success).toBe(false);
  });
});

function validBody() {
  return { occurredAt: "2026-10-11T10:00:00.000Z", category: "other", body: "Text" };
}

describe("hazard HZ-017 late and corrected notes", () => {
  it("records a note about earlier today with the event time and the time it was written", () => {
    const result = checkNote(draft({ when: { kind: "earlier", time: "07:30" } }), context, NOW);
    // 07:30 in the UK on 11 October 2026 is 06:30 UTC (British Summer Time).
    expect(result.ok && result.row.occurred_at).toBe("2026-10-11T06:30:00.000Z");
    expect(result.ok && result.row.device_time).toBe("2026-10-11T10:00:00.000Z");
  });

  it("supersedes the original with a reason, never editing it", () => {
    const correction = {
      supersedesId: "0199c000-0000-7000-8000-000000000009",
      reason: "Wrong room",
    };
    const result = checkNote(draft({ correction }), context, NOW);
    expect(result.ok && result.row).toMatchObject({
      supersedes_id: correction.supersedesId,
      correction_reason: "Wrong room",
    });
    if (!result.ok) throw new Error("expected a valid correction");
    expect(uploadBody(result.row)).toMatchObject({
      supersedesId: correction.supersedesId,
      correctionReason: "Wrong room",
    });
  });

  it.each(["", "  ", "no", "x".repeat(CORRECTION_REASON_LIMITS.max + 1)])(
    "refuses a correction with the reason %j",
    (reason) => {
      const result = checkNote(
        draft({ correction: { supersedesId: "0199c000-0000-7000-8000-000000000009", reason } }),
        context,
        NOW,
      );
      expect(!result.ok && result.errors.reason?.key).toMatch(/^mobile\.correction\.reason/);
    },
  );
});

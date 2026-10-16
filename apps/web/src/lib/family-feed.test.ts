import { describe, expect, it } from "vitest";
import {
  draftProblems,
  type FeedDraft,
  familyUpdatesShown,
  feedProblemField,
  isFamilyMember,
  isPortalOnly,
  needsConfirmation,
  previewRefusal,
  publishSource,
  sourceOptions,
} from "./family-feed";

const NOW = new Date("2026-10-16T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe("family updates on the web (COMMS-001, HZ-022)", () => {
  it.each([
    ["names_another_resident", "shared_note", "text"],
    ["clinical_term", "shared_note", "text"],
    ["contact_details", "photo", "caption"],
    ["text_required", "shared_note", "text"],
    ["needs_confirmation", "shared_note", "confirmationReason"],
    ["photo_shows_other_people", "photo", "onlyThisPerson"],
    ["photo_basis_missing", "photo", "source"],
    ["photo_not_for_feed", "photo", "source"],
    ["source_corrected", "activity", "source"],
    ["not_for_the_feed", "activity", "source"],
    ["something_new", "activity", "source"],
    ["publishing_held", "activity", null],
    ["person_record_closed", "shared_note", null],
  ] as const)("puts %s for a %s at %s", (problem, kind, field) => {
    expect(feedProblemField(problem, kind)).toBe(field);
  });

  it("hazard HZ-061 says a hold first, and each other problem at its field", () => {
    const refusal = previewRefusal(
      {
        ok: false,
        problems: [
          { problem: "names_another_resident", message: "Do not name other residents." },
          { problem: "publishing_held", message: "Updates for this person are on hold." },
        ],
      },
      "shared_note",
    );
    expect(refusal).toMatchObject({
      ok: false,
      code: "held",
      message: "Updates for this person are on hold. Do not name other residents.",
      fields: { text: "Do not name other residents." },
    });
    const held = previewRefusal(
      { ok: false, problems: [{ problem: "publishing_held", message: "On hold." }] },
      "activity",
    );
    expect(held).toEqual({ ok: false, code: "held", message: "On hold." });
    expect(previewRefusal({ ok: true, problems: [] }, "activity")).toBeNull();
  });

  it("asks for a reason only when the preview needs a confirmation", () => {
    expect(needsConfirmation(null)).toBe(false);
    expect(needsConfirmation({ problems: [{ problem: "needs_confirmation", message: "" }] })).toBe(
      true,
    );
    expect(needsConfirmation({ problems: [{ problem: "clinical_term", message: "" }] })).toBe(
      false,
    );
  });

  it("hazard HZ-022 offers recent uncorrected records and only photos added for the feed", () => {
    const options = sourceOptions(
      {
        notes: [
          { id: "n1", occurredAt: day(1), superseded: false, category: "activity" },
          { id: "n2", occurredAt: day(2), superseded: true, category: "mood" },
          { id: "n3", occurredAt: day(20), superseded: false, category: "other" },
          { id: "n4", occurredAt: day(-1), superseded: false, category: "other" },
        ],
        activities: [
          { id: "a1", occurredAt: day(3), superseded: false, activity: "Garden club" },
          { id: "a2", occurredAt: day(0.5), superseded: false, activity: "Music" },
        ],
        photos: [
          {
            id: "p1",
            title: "Baking",
            category: "feed_photo",
            createdAt: day(1),
            contentType: "image/jpeg",
            status: "available",
          },
          {
            id: "p2",
            title: "Identification",
            category: "person_photo",
            createdAt: day(1),
            contentType: "image/jpeg",
            status: "available",
          },
          {
            id: "p3",
            title: "Wound",
            category: "care_attachment",
            createdAt: day(1),
            contentType: "image/png",
            status: "available",
          },
          {
            id: "p4",
            title: "Held",
            category: "feed_photo",
            createdAt: day(1),
            contentType: "image/png",
            status: "quarantined",
          },
        ],
      },
      NOW,
      (category) => `Note: ${category}`,
    );
    expect(options.shared_note.map((o) => o.id)).toEqual(["n1"]);
    expect(options.shared_note[0]?.label).toBe("Note: activity");
    expect(options.activity.map((o) => o.label)).toEqual(["Music", "Garden club"]);
    expect(options.photo.map((o) => o.id)).toEqual(["p1"]);
  });

  const draft = (change: Partial<FeedDraft>): FeedDraft => ({
    kind: "shared_note",
    sourceId: "s",
    text: "",
    caption: "",
    onlyThisPerson: false,
    confirmationReason: "",
    ...change,
  });

  it("sends only the fields a source's kind uses", () => {
    expect(publishSource(draft({ text: "  Addie baked scones.  " }))).toEqual({
      kind: "shared_note",
      noteId: "s",
      text: "Addie baked scones.",
    });
    expect(publishSource(draft({ kind: "activity", text: "ignored" }))).toEqual({
      kind: "activity",
      activityId: "s",
    });
    expect(publishSource(draft({ kind: "photo", caption: " ", onlyThisPerson: true }))).toEqual({
      kind: "photo",
      documentId: "s",
      caption: null,
      onlyThisPerson: true,
    });
  });

  it("finds a missing record, missing words and words too long before asking the API", () => {
    const words = {
      chooseSource: "Choose",
      textRequired: "Write",
      tooLong: (max: number) => `Max ${max}`,
    };
    expect(draftProblems(draft({ sourceId: "" }), words)).toEqual([
      { field: "source", message: "Choose" },
      { field: "text", message: "Write" },
    ]);
    expect(draftProblems(draft({ text: "x".repeat(1001) }), words)).toEqual([
      { field: "text", message: "Max 1000" },
    ]);
    expect(draftProblems(draft({ kind: "activity" }), words)).toEqual([]);
    expect(
      draftProblems(draft({ kind: "photo", confirmationReason: "x".repeat(501) }), words),
    ).toEqual([{ field: "confirmationReason", message: "Max 500" }]);
  });

  it("shows the family's updates link only in a portal session with feed read", () => {
    expect(familyUpdatesShown(["comms.feed.read"])).toBe(true);
    expect(familyUpdatesShown(["comms.feed.publish"])).toBe(false);
    expect(isPortalOnly(["comms.portal.family", "comms.feed.read"])).toBe(true);
    expect(isPortalOnly(["comms.portal.family", "people.person.read"])).toBe(false);
    expect(isPortalOnly(["people.person.read", "comms.feed.publish"])).toBe(false);
    // A family member whose link was revoked has no permissions at all: sent to the updates page.
    expect(isFamilyMember({ permissions: [] })).toBe(true);
    expect(isFamilyMember({ permissions: ["comms.portal.family", "comms.feed.read"] })).toBe(true);
    expect(isFamilyMember({ permissions: ["people.person.read"] })).toBe(false);
    expect(isFamilyMember({ permissions: ["care.note.write"] })).toBe(false);
  });
});

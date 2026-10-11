import { describe, expect, it } from "vitest";
import { parseCommunicationNeeds, toPersonView, UNREADABLE_NEEDS } from "./person-view";
import type { PersonRow } from "./queries";

const row: PersonRow = {
  id: "p1",
  preferred_name: null,
  given_name: "Ada",
  family_name: "Example",
  room_label: "Room 1",
  photo_document_id: null,
  communication_needs: null,
  allergy_status: "unknown",
  date_of_birth: "1938-04-12",
  nhs_number: "9990000018",
  allergy_count: 0,
};

describe("parseCommunicationNeeds", () => {
  it.each([null, undefined, "", "  "])("treats %j as none recorded", (raw) => {
    expect(parseCommunicationNeeds(raw)).toEqual({ needs: [], unreadable: false });
  });

  it("reads the AIS shape", () => {
    expect(
      parseCommunicationNeeds(
        JSON.stringify([{ code: "123", display: " Large print ", preferredFormat: "16 point" }]),
      ),
    ).toEqual({
      needs: [{ code: "123", display: "Large print", preferredFormat: "16 point" }],
      unreadable: false,
    });
  });

  it.each(["{", '{"display":"x"}', "[1]", '[{"code":"1"}]', '[{"display":""}]'])(
    "flags %s as unreadable rather than dropping it",
    (raw) => {
      expect(parseCommunicationNeeds(raw).unreadable).toBe(true);
    },
  );

  it("keeps readable entries next to unreadable ones", () => {
    const result = parseCommunicationNeeds('[{"display":"Easy read"}, 7]');
    expect(result.needs.map((n) => n.display)).toEqual(["Easy read"]);
    expect(result.unreadable).toBe(true);
  });
});

describe("toPersonView", () => {
  it("still raises the communication flag when the stored value is unreadable", () => {
    const view = toPersonView({ ...row, communication_needs: "not json" });
    expect(view.communicationNeeds).toEqual([UNREADABLE_NEEDS]);
  });

  it("speaks the allergy warning for an unknown status", () => {
    expect(toPersonView(row).accessibilityLabel).toBe(
      "Ada Example. Room 1. Allergies not recorded. Check before giving food or medicines.",
    );
  });

  it("copes with a missing name without crashing", () => {
    const view = toPersonView({ ...row, given_name: null, family_name: null });
    expect(view.displayName).toBe("Name not recorded");
  });

  it("coerces the SQLite count", () => {
    expect(toPersonView({ ...row, allergy_count: Number("2") }).allergyCount).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  checkPropertyDisposal,
  checkPropertyItemIn,
  checkPropertyLoss,
  checkPropertyReturn,
  isValuable,
  type KeyIssue,
  outstandingKeys,
  outstandingProperty,
  type PropertyItemIn,
  type PropertyItemRecord,
  type PropertyReturn,
  propertyAwayWithPerson,
  propertyToSendWithPerson,
} from "./property";

const SIGNED_AT = new Date("2026-10-12T15:00:00Z");

function itemIn(overrides: Partial<PropertyItemIn> = {}): PropertyItemIn {
  return {
    description: "Blue wool cardigan",
    category: "clothing",
    quantity: 2,
    receivedOn: "2026-10-12",
    recordedBy: "senior-1",
    acknowledgement: { signer: "person", name: "Ada Example", signedAt: SIGNED_AT },
    ...overrides,
  };
}

describe("property in", () => {
  it("accepts a described, dated and acknowledged item", () => {
    expect(checkPropertyItemIn(itemIn())).toEqual({ ok: true });
  });

  it("accepts a witnessed valuable", () => {
    expect(
      checkPropertyItemIn(
        itemIn({
          description: "Gold wedding ring",
          category: "jewellery",
          quantity: 1,
          witnessedBy: "senior-2",
        }),
      ),
    ).toEqual({ ok: true });
  });

  it.each<[string, Partial<PropertyItemIn>, readonly string[]]>([
    ["no description", { description: "  " }, ["description_required"]],
    ["cash", { category: "Cash" }, ["cash_not_allowed"]],
    ["money in another word", { category: "coins" }, ["cash_not_allowed"]],
    ["an unknown category", { category: "spaceship" }, ["unknown_category"]],
    ["a fractional quantity", { quantity: 1.5 }, ["quantity_invalid"]],
    ["no quantity", { quantity: 0 }, ["quantity_invalid"]],
    ["an impossible date", { receivedOn: "2026-02-30" }, ["invalid_date"]],
    [
      "a signature without a name",
      { acknowledgement: { signer: "representative", name: "", signedAt: SIGNED_AT } },
      ["signer_name_required"],
    ],
    [
      "unable to sign without a reason or witness",
      { acknowledgement: { signer: "unable_to_sign", signedAt: SIGNED_AT } },
      ["unable_reason_required", "witness_required"],
    ],
    ["an unwitnessed valuable", { category: "watch" }, ["witness_required"]],
    ["an item marked valuable without a witness", { valuable: true }, ["witness_required"]],
    [
      "the recorder witnessing their own entry",
      { category: "jewellery", witnessedBy: "senior-1" },
      ["witness_same_as_recorder"],
    ],
  ])("refuses %s", (_label, overrides, problems) => {
    expect(checkPropertyItemIn(itemIn(overrides))).toEqual({ ok: false, problems });
  });

  it("knows what counts as valuable", () => {
    expect(isValuable({ category: "documents" })).toBe(true);
    expect(isValuable({ category: "clothing" })).toBe(false);
    expect(isValuable({ category: "clothing", valuable: true })).toBe(true);
    expect(isValuable({ category: "not a category" })).toBe(false);
  });
});

describe("property out", () => {
  const ring: PropertyItemRecord = {
    id: "i1",
    category: "jewellery",
    receivedOn: "2026-10-12",
    status: "held",
  };
  const cardigan: PropertyItemRecord = {
    id: "i2",
    category: "clothing",
    receivedOn: "2026-10-12",
    status: "held",
  };

  function ret(overrides: Partial<PropertyReturn> = {}): PropertyReturn {
    return {
      returnedOn: "2026-11-02",
      returnedBy: "manager-1",
      recipientName: "Ben Example",
      recipientCapacity: "personal_representative",
      signature: { signer: "representative", name: "Ben Example", signedAt: SIGNED_AT },
      witnessedBy: "senior-2",
      ...overrides,
    };
  }

  it("returns a valuable to the personal representative after a death, witnessed", () => {
    expect(checkPropertyReturn(ring, ret(), "deceased")).toEqual({ ok: true });
  });

  it("returns clothing to the person on discharge without a witness", () => {
    expect(
      checkPropertyReturn(
        cardigan,
        ret({
          recipientCapacity: "person",
          witnessedBy: null,
          signature: { signer: "person", name: "Ada Example", signedAt: SIGNED_AT },
        }),
        "discharged",
      ),
    ).toEqual({ ok: true });
  });

  it.each<[string, PropertyItemRecord, Partial<PropertyReturn>, string, readonly string[]]>([
    [
      "an item already returned",
      { ...cardigan, status: "returned" },
      {},
      "deceased",
      ["already_closed"],
    ],
    [
      "a return dated before receipt",
      cardigan,
      { returnedOn: "2026-10-01" },
      "deceased",
      ["returned_before_received"],
    ],
    ["an impossible date", cardigan, { returnedOn: "soon" }, "deceased", ["invalid_date"]],
    ["no recipient", cardigan, { recipientName: "" }, "deceased", ["recipient_required"]],
    [
      "return to the person after their death",
      cardigan,
      { recipientCapacity: "person" },
      "deceased",
      ["recipient_not_entitled"],
    ],
    [
      "return to a family member without authority after a death",
      cardigan,
      { recipientCapacity: "representative" },
      "deceased",
      ["recipient_not_entitled"],
    ],
    ["an unwitnessed valuable", ring, { witnessedBy: null }, "discharged", ["witness_required"]],
    [
      "the returner witnessing",
      ring,
      { witnessedBy: "manager-1" },
      "discharged",
      ["witness_same_as_recorder"],
    ],
  ])("refuses %s", (_label, item, overrides, status, problems) => {
    expect(checkPropertyReturn(item, ret(overrides), status as never)).toEqual({
      ok: false,
      problems,
    });
  });

  it("disposes of an item only with a reason and a witness", () => {
    expect(
      checkPropertyDisposal(cardigan, {
        on: "2026-10-20",
        by: "senior-1",
        reason: "Worn out; agreed with Ada",
        witnessedBy: "senior-2",
      }),
    ).toEqual({ ok: true });
    expect(
      checkPropertyDisposal(
        { ...cardigan, status: "sent_with_person" },
        { on: "2026-10-01", by: "senior-1", reason: "", witnessedBy: null },
      ),
    ).toEqual({
      ok: false,
      problems: [
        "already_closed",
        "returned_before_received",
        "reason_required",
        "witness_required",
      ],
    });
    expect(
      checkPropertyDisposal(cardigan, { on: "bad", by: "s", reason: "Torn", witnessedBy: "w" }),
    ).toEqual({ ok: false, problems: ["invalid_date"] });
  });

  it("records a loss only with an incident", () => {
    expect(checkPropertyLoss(ring, { on: "2026-10-20", incidentId: "incident-1" })).toEqual({
      ok: true,
    });
    expect(checkPropertyLoss({ ...ring, status: "lost" }, { on: "x", incidentId: null })).toEqual({
      ok: false,
      problems: ["already_closed", "invalid_date", "incident_required"],
    });
  });
});

describe("what is still to come back", () => {
  const items: PropertyItemRecord[] = [
    { id: "a", category: "clothing", receivedOn: "2026-10-12", status: "held" },
    { id: "b", category: "sensory_aid", receivedOn: "2026-10-12", status: "held" },
    { id: "c", category: "dentures", receivedOn: "2026-10-12", status: "sent_with_person" },
    { id: "d", category: "jewellery", receivedOn: "2026-10-12", status: "returned" },
    { id: "e", category: "clothing", receivedOn: "2026-10-12", status: "disposed" },
    { id: "f", category: "watch", receivedOn: "2026-10-12", status: "lost" },
    { id: "g", category: "mobility_aid", receivedOn: "2026-10-12", status: "held" },
  ];

  it("lists outstanding items for the exit checklist", () => {
    expect(outstandingProperty(items).map((i) => i.id)).toEqual(["a", "b", "c", "g"]);
  });

  it("lists red bag items to send and items away with the person", () => {
    expect(propertyToSendWithPerson(items).map((i) => i.id)).toEqual(["b", "g"]);
    expect(propertyAwayWithPerson(items).map((i) => i.id)).toEqual(["c"]);
  });

  it("lists keys not yet returned or reported lost", () => {
    const keys: KeyIssue[] = [
      {
        id: "k1",
        label: "Room 4",
        issuedOn: "2026-10-12",
        issuedTo: "person",
        returnedOn: null,
        reportedLostOn: null,
      },
      {
        id: "k2",
        label: "Locker",
        issuedOn: "2026-10-12",
        issuedTo: "person",
        returnedOn: "2026-10-20",
        reportedLostOn: null,
      },
      {
        id: "k3",
        label: "Front door fob",
        issuedOn: "2026-10-12",
        issuedTo: "representative",
        returnedOn: null,
        reportedLostOn: "2026-10-18",
      },
    ];
    expect(outstandingKeys(keys).map((k) => k.id)).toEqual(["k1"]);
  });
});

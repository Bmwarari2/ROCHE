import type { HospitalTransferOut, TransferPack } from "@harbour/contracts";
import { describe, expect, it } from "vitest";
import {
  checksToDo,
  needsAcknowledgement,
  openTransfer,
  packIdentity,
  reasonLongEnough,
  sectionsInOrder,
} from "./transfer-pack";

// Invented person (section 20): Frank Dummy, NHS number in the 999 range.
const PERSON = "0194d000-0000-7000-8600-000000000006";
const OTHER = "0194d000-0000-7000-8600-000000000005";

const section = (
  key: string,
  critical: boolean,
  status: "included" | "not_recorded",
): TransferPack["sections"][number] => ({
  key,
  title: key,
  critical,
  hazardIds: [],
  status,
  asOf: null,
});

function pack(overrides: Partial<TransferPack> = {}): TransferPack {
  return {
    personId: PERSON,
    generatedAt: "2026-10-31T10:00:00.000Z",
    generatedBy: "0194d000-0000-7000-8000-000000000001",
    identity: {
      personId: PERSON,
      givenName: "Frank",
      familyName: "Dummy",
      preferredName: null,
      dateOfBirth: "1946-01-25",
      nhsNumber: "9990000069",
    },
    sections: [],
    content: {},
    missingCritical: [],
    missingExpected: [],
    attention: [],
    itemsLeftBehind: [],
    complete: true,
    ...overrides,
  };
}

describe("sectionsInOrder", () => {
  it("hazard HZ-023 lists missing safety-critical sections first, never leaving one out", () => {
    const sections = [
      section("photo", true, "included"),
      section("allergies", true, "not_recorded"),
      section("baseline", false, "not_recorded"),
      section("communication", true, "not_recorded"),
      section("contacts", false, "included"),
    ];
    const ordered = sectionsInOrder(pack({ sections }));
    expect(ordered.map((s) => s.key)).toEqual([
      "allergies",
      "communication",
      "baseline",
      "photo",
      "contacts",
    ]);
    expect(ordered).toHaveLength(sections.length);
  });
});

describe("packIdentity", () => {
  it("hazard HZ-001 names the person from the pack itself", () => {
    expect(packIdentity(pack(), PERSON)).toEqual({
      givenName: "Frank",
      familyName: "Dummy",
      preferredName: null,
      dateOfBirth: "1946-01-25",
      nhsNumber: "9990000069",
    });
  });

  it.each([
    ["the pack is for someone else", pack({ personId: OTHER })],
    ["the identity is someone else's", pack({ identity: { ...pack().identity, personId: OTHER } })],
    ["the name is missing", pack({ identity: { ...pack().identity, familyName: " " } })],
  ])("hazard HZ-001 shows no pack when %s", (_, value) => {
    expect(packIdentity(value, PERSON)).toBeNull();
  });
});

const transfer = (
  overrides: Partial<HospitalTransferOut> & { pack?: TransferPack } = {},
): HospitalTransferOut => ({
  id: "0194d000-0000-7000-8700-000000000001",
  personId: PERSON,
  locationId: "0194d000-0000-7000-8100-000000000001",
  leftAt: "2026-10-31T10:00:00.000Z",
  hospitalName: "Example General Hospital",
  hospitalOdsCode: null,
  reason: null,
  pack: pack(),
  missingCritical: [],
  missingExpected: [],
  itemsSent: [],
  handedOverAt: null,
  handedOverBy: null,
  acknowledgement: null,
  returnedAt: null,
  returnChecks: [],
  version: 1,
  ...overrides,
});

describe("needsAcknowledgement", () => {
  it.each([
    ["a complete pack", transfer(), false],
    [
      "a pack missing only an expected section",
      transfer({ missingExpected: ["baseline"], pack: pack({ complete: false }) }),
      false,
    ],
    [
      "a pack missing a safety-critical section",
      transfer({ missingCritical: ["communication"], pack: pack({ complete: false }) }),
      true,
    ],
    [
      "resuscitation records that disagree",
      transfer({
        pack: pack({
          complete: false,
          attention: [
            {
              key: "resuscitation",
              code: "resuscitation_conflict",
              message: "",
              acknowledge: true,
              onDate: null,
            },
          ],
        }),
      }),
      true,
    ],
    [
      "an overdue resuscitation review only",
      transfer({
        pack: pack({
          complete: false,
          attention: [
            {
              key: "resuscitation",
              code: "resuscitation_review_overdue",
              message: "",
              acknowledge: false,
              onDate: "2026-01-01",
            },
          ],
        }),
      }),
      false,
    ],
  ])("hazard HZ-023 for %s: %s", (_, value, expected) => {
    expect(needsAcknowledgement(value)).toBe(expected);
  });

  it("hazard HZ-023 takes a reason only at the domain's minimum length", () => {
    expect(reasonLongEnough("Emergency")).toBe(false);
    expect(reasonLongEnough("  Emergency; GP asked  ")).toBe(true);
  });
});

describe("openTransfer and checksToDo", () => {
  it("finds the transfer not yet returned from, and the checks still to do", () => {
    const back = transfer({ id: "a", returnedAt: "2026-10-30T10:00:00.000Z" });
    const away = transfer({ id: "b" });
    expect(openTransfer([away, back])?.id).toBe("b");
    expect(openTransfer([back])).toBeNull();
    const checks = checksToDo(
      transfer({
        returnChecks: [
          { key: "skin_checked", title: "", hazardIds: [], doneBy: null, doneAt: null },
          {
            key: "discharge_letter_filed",
            title: "",
            hazardIds: [],
            doneBy: "x",
            doneAt: "2026-10-31T11:00:00.000Z",
          },
        ],
      }),
    );
    expect(checks.map((c) => c.key)).toEqual(["skin_checked"]);
  });
});

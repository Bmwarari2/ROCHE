import type { Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  changeProtocolHref,
  checkKey,
  checkSays,
  currentMedicines,
  DOSE_FIELD_FOR_PROBLEM,
  doseRows,
  type HomelyDose,
  type HomelyProtocol,
  homelyShown,
  mayGiveHomely,
  mayManageProtocols,
  mayMarkInError,
  memberOptions,
  newProtocolHref,
  PROTOCOL_FIELD_FOR_PROBLEM,
  personHomelyHref,
  protocolChip,
  protocolDefaults,
  protocolsHref,
  readAmount,
  readDose,
  readDoseCheck,
  readEnteredInError,
  readProtocol,
  readProtocolChange,
  readWithdraw,
  usableProtocols,
  withdrawProtocolHref,
} from "./homely-remedies";

/**
 * Homely remedies on the web (slice 55; MEDS-007; medicines.md section 15.3): protocol state as an
 * icon and words, the forms read with every mistake at its field, and the doses with what marked
 * them entered in error. Hazard ids in the names (HZ-120 homely remedies within the protocol; HZ-007
 * allergies compared by the giver).
 */

// A translator that names the key, so the tests read the rule rather than the copy.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as Translator;

const form = (values: Record<string, string | readonly string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string") f.set(k, v);
    else for (const each of v) f.append(k, each);
  }
  return f;
};

const MEMBER = "0194d000-0000-7000-8000-00000000b001";
const OTHER = "0194d000-0000-7000-8000-00000000b002";
const PROTOCOL = "0194d000-0000-7000-8000-00000000c001";
const LOCATION = "0194d000-0000-7000-8000-000000000101";

const date = (name: string, iso: string) => {
  const [y, m, d] = iso.split("-");
  return { [`${name}-day`]: d ?? "", [`${name}-month`]: m ?? "", [`${name}-year`]: y ?? "" };
};

const protocolForm = (over: Record<string, string | readonly string[]> = {}) =>
  form({
    productName: "Paracetamol 500mg tablets",
    vmpId: "",
    indication: "Mild pain or a raised temperature",
    doseQuantity: "2",
    unitName: "tablet",
    minIntervalHours: "4",
    maxDailyQuantity: "8",
    maxDays: "2",
    authorisedMemberIds: [MEMBER],
    approvedByName: "Dr A Example",
    approvedByRole: "gp",
    ...date("approvedOn", "2026-10-01"),
    ...date("reviewOn", "2027-10-01"),
    ...over,
  });

const protocol = (over: Partial<HomelyProtocol> = {}): HomelyProtocol => ({
  id: PROTOCOL,
  locationId: LOCATION,
  productName: "Paracetamol 500mg tablets",
  vmpId: null,
  indication: "Mild pain",
  doseQuantity: 2,
  unitName: "tablet",
  minIntervalHours: 4,
  maxDailyQuantity: 8,
  maxDays: 2,
  authorisedMemberIds: [MEMBER],
  approvedByName: "Dr A Example",
  approvedByRole: "gp",
  approvedOn: "2026-10-01",
  reviewOn: "2027-10-01",
  withdrawnAt: null,
  withdrawnReason: null,
  changeReason: null,
  status: "in_use",
  statusWords: "In use",
  version: 1,
  ...over,
});

const dose = (over: Partial<HomelyDose> = {}): HomelyDose => ({
  id: "0194d000-0000-7000-8000-00000000d001",
  personId: "0194d000-0000-7000-8000-00000000e001",
  protocolId: PROTOCOL,
  protocolVersion: 1,
  productName: "Paracetamol 500mg tablets",
  outcome: "given",
  quantity: 2,
  unitName: "tablet",
  reason: "Headache",
  givenAt: "2026-11-06T10:00:00.000Z",
  givenBy: MEMBER,
  allergiesChecked: true,
  medicinesCompared: true,
  alreadyGivenReason: null,
  flags: [],
  recordedAt: "2026-11-06T10:00:00.000Z",
  supersedesId: null,
  correctionReason: null,
  enteredInErrorBy: null,
  ...over,
});

describe("hazard HZ-120 who sees and changes homely remedies", () => {
  it.each([
    [["medicines.record.manage"], true, true, false],
    [["medicines.emar.administer"], true, false, true],
    [["care.plan.read"], true, false, false],
    [["care.note.read"], false, false, false],
  ] as const)("%j: shown %s, manage %s, give %s", (permissions, shown, manage, give) => {
    expect(homelyShown(permissions)).toBe(shown);
    expect(mayManageProtocols(permissions)).toBe(manage);
    expect(mayGiveHomely(permissions)).toBe(give);
  });

  it("builds the addresses under the home and the person's medicines", () => {
    expect(protocolsHref(LOCATION)).toBe(`/medicines-stock/${LOCATION}/homely-remedies`);
    expect(newProtocolHref(LOCATION)).toBe(`/medicines-stock/${LOCATION}/homely-remedies/new`);
    expect(changeProtocolHref(LOCATION, PROTOCOL)).toBe(
      `/medicines-stock/${LOCATION}/homely-remedies/${PROTOCOL}/change`,
    );
    expect(withdrawProtocolHref(LOCATION, PROTOCOL)).toBe(
      `/medicines-stock/${LOCATION}/homely-remedies/${PROTOCOL}/withdraw`,
    );
    expect(personHomelyHref("p1")).toBe("/people/p1/medicines/homely-remedies");
  });
});

describe("hazard HZ-120 a protocol's state is an icon and the API's words, never colour alone", () => {
  it.each([
    ["in_use", "In use", "done"],
    ["review_overdue", "Review overdue: not to be used until reviewed", "overdue"],
    ["withdrawn", "Withdrawn", "notApplicable"],
  ] as const)("%s", (status, words, chip) => {
    const shown = protocolChip({ status, statusWords: words });
    expect(shown.status).toBe(chip);
    expect(shown.label).toBe(words);
    expect(shown.icon).toBeTruthy();
  });

  it("offers only protocols in use for a dose", () => {
    const list = [
      protocol({ id: "a" }),
      protocol({ id: "b", status: "review_overdue" }),
      protocol({ id: "c", status: "withdrawn" }),
    ];
    expect(usableProtocols(list).map((p) => p.id)).toEqual(["a"]);
  });
});

describe("hazard HZ-120 reading the protocol form", () => {
  it("reads a whole protocol", () => {
    const read = readProtocol(protocolForm({ vmpId: "322236009" }), t);
    expect(read).toEqual({
      ok: true,
      body: {
        productName: "Paracetamol 500mg tablets",
        vmpId: "322236009",
        indication: "Mild pain or a raised temperature",
        doseQuantity: 2,
        unitName: "tablet",
        minIntervalHours: 4,
        maxDailyQuantity: 8,
        maxDays: 2,
        authorisedMemberIds: [MEMBER],
        approvedByName: "Dr A Example",
        approvedByRole: "gp",
        approvedOn: "2026-10-01",
        reviewOn: "2027-10-01",
      },
    });
  });

  it("sends no dm+d code when none is typed, and each member once", () => {
    const read = readProtocol(protocolForm({ authorisedMemberIds: [MEMBER, OTHER, MEMBER] }), t);
    expect(read.ok && read.body.vmpId).toBeNull();
    expect(read.ok && read.body.authorisedMemberIds).toEqual([MEMBER, OTHER]);
  });

  it.each([
    ["productName", { productName: "" }, "medicines.homely.form.productError"],
    ["productName", { productName: "x".repeat(201) }, "medicines.homely.form.productError"],
    ["vmpId", { vmpId: "12ab" }, "medicines.homely.form.vmpError"],
    ["indication", { indication: " " }, "medicines.homely.form.indicationError"],
    ["doseQuantity", { doseQuantity: "0" }, "medicines.homely.form.doseError"],
    ["doseQuantity", { doseQuantity: "02" }, "medicines.homely.form.doseError"],
    ["doseQuantity", { doseQuantity: "1.2345" }, "medicines.homely.form.doseError"],
    ["unitName", { unitName: "" }, "medicines.homely.form.unitError"],
    ["minIntervalHours", { minIntervalHours: "0" }, "medicines.homely.form.intervalError"],
    ["minIntervalHours", { minIntervalHours: "169" }, "medicines.homely.form.intervalError"],
    ["minIntervalHours", { minIntervalHours: "4.125" }, "medicines.homely.form.intervalError"],
    ["maxDailyQuantity", { maxDailyQuantity: "" }, "medicines.homely.form.dailyError"],
    ["maxDailyQuantity", { maxDailyQuantity: "1" }, "medicines.homely.form.dailyBelowDose"],
    ["maxDays", { maxDays: "0" }, "medicines.homely.form.daysError"],
    ["maxDays", { maxDays: "1.5" }, "medicines.homely.form.daysError"],
    ["maxDays", { maxDays: "366" }, "medicines.homely.form.daysError"],
    ["authorisedMemberIds", { authorisedMemberIds: [] }, "medicines.homely.form.staffError"],
    [
      "authorisedMemberIds",
      { authorisedMemberIds: ["not-an-id"] },
      "medicines.homely.form.staffError",
    ],
    ["approvedByName", { approvedByName: "" }, "medicines.homely.form.approvedByError"],
    ["approvedByRole", { approvedByRole: "nurse" }, "medicines.homely.form.roleError"],
    ["reviewOn", date("reviewOn", "2026-10-01"), "medicines.homely.form.reviewAfterError"],
  ] as const)("%s: %j", (field, over, key) => {
    const read = readProtocol(protocolForm(over), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[field]).toBe(key);
  });

  it("says a date that is not real at its field", () => {
    const read = readProtocol(protocolForm(date("approvedOn", "2026-02-30")), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors.approvedOn).toBeTruthy();
  });

  it("leaves the rate table's limits to the API (a long review is not refused here)", () => {
    expect(readProtocol(protocolForm(date("reviewOn", "2029-10-01")), t).ok).toBe(true);
  });

  it("needs a new reason and sends the version read to change a protocol", () => {
    expect(readProtocolChange(protocolForm({ reason: "Dose agreed again" }), t, 3)).toMatchObject({
      ok: true,
      body: { reason: "Dose agreed again", version: 3, doseQuantity: 2 },
    });
    const none = readProtocolChange(protocolForm({ doseQuantity: "" }), t, 3);
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.errors.reason).toBe("medicines.homely.form.changeReasonError");
      expect(none.errors.doseQuantity).toBe("medicines.homely.form.doseError");
    }
  });

  it("needs a reason to withdraw", () => {
    expect(readWithdraw(form({ reason: "No longer agreed" }), t, 2)).toEqual({
      ok: true,
      body: { reason: "No longer agreed", version: 2 },
    });
    expect(readWithdraw(form({ reason: "" }), t, 2)).toEqual({
      ok: false,
      errors: { reason: "medicines.homely.withdraw.reasonError" },
    });
  });

  it("starts a change from the protocol as the API holds it", () => {
    const values = protocolDefaults(protocol({ vmpId: null, minIntervalHours: 4.5 }));
    expect(values.vmpId).toBe("");
    expect(values.minIntervalHours).toBe("4.5");
    expect(values.approvedOn).toBe("2026-10-01");
  });
});

describe("hazard HZ-120 hazard HZ-007 checking and recording a dose", () => {
  it.each([
    ["2", 2],
    ["0.5", 0.5],
    ["10.125", 10.125],
    ["0", null],
    ["02", null],
    ["1.2345", null],
    ["100001", null],
    ["two", null],
  ] as const)("reads the amount %s as %s, never rounded", (raw, value) => {
    expect(readAmount(raw)).toBe(value);
  });

  it("reads the check", () => {
    expect(readDoseCheck(form({ protocolId: PROTOCOL, quantity: "2" }), t)).toEqual({
      ok: true,
      body: { protocolId: PROTOCOL, quantity: 2 },
    });
    expect(readDoseCheck(form({ protocolId: "", quantity: "" }), t)).toEqual({
      ok: false,
      errors: {
        protocolId: "medicines.homely.dose.protocolError",
        quantity: "medicines.homely.dose.quantityError",
      },
    });
  });

  it("records a dose now, with the allergies compared, never as already given", () => {
    const read = readDose(
      form({
        protocolId: PROTOCOL,
        quantity: "2",
        reason: "Headache",
        allergiesChecked: "yes",
        medicinesChecked: "yes",
      }),
      t,
      { id: "id-1" },
    );
    expect(read).toEqual({
      ok: true,
      body: {
        id: "id-1",
        protocolId: PROTOCOL,
        quantity: 2,
        reason: "Headache",
        allergiesChecked: true,
        medicinesCompared: true,
        alreadyGiven: null,
      },
    });
  });

  it.each([
    ["reason", { reason: "" }, "medicines.homely.dose.reasonError"],
    ["allergiesChecked", { allergiesChecked: "" }, "medicines.homely.dose.allergiesError"],
    ["quantity", { quantity: "0" }, "medicines.homely.dose.quantityError"],
    // HZ-120: the remedy is compared with every current medicine, not only the same product.
    ["medicinesChecked", { medicinesChecked: "" }, "medicines.homely.dose.medicinesError"],
  ] as const)("hazard HZ-120 refuses without %s", (field, over, key) => {
    const read = readDose(
      form({
        protocolId: PROTOCOL,
        quantity: "2",
        reason: "Headache",
        allergiesChecked: "yes",
        medicinesChecked: "yes",
        ...over,
      }),
      t,
      { id: "id-1" },
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.errors[field]).toBe(key);
  });

  it("shows what the check found in the API's words", () => {
    expect(checkSays({ problems: [] })).toEqual({ within: true });
    expect(
      checkSays({
        problems: [
          {
            problem: "too_soon",
            message: "It is too soon after the last dose under this protocol.",
          },
          { problem: "refer_to_gp", message: "The protocol's days have been used." },
        ],
      }),
    ).toEqual({
      within: false,
      messages: [
        "It is too soon after the last dose under this protocol.",
        "The protocol's days have been used.",
      ],
    });
  });

  it("needs a new check when the protocol or the amount changes", () => {
    expect(checkKey(PROTOCOL, " 2 ")).toBe(checkKey(PROTOCOL, "2"));
    expect(checkKey(PROTOCOL, "2")).not.toBe(checkKey(PROTOCOL, "1"));
    expect(checkKey(PROTOCOL, "2")).not.toBe(checkKey(OTHER, "2"));
  });

  it.each([
    ["homely_dose_differs", DOSE_FIELD_FOR_PROBLEM, "quantity"],
    ["homely_too_soon", DOSE_FIELD_FOR_PROBLEM, undefined],
    ["homely_review_too_far", PROTOCOL_FIELD_FOR_PROBLEM, "reviewOn"],
    ["homely_unknown_member", PROTOCOL_FIELD_FOR_PROBLEM, "authorisedMemberIds"],
    ["homely_max_days_out_of_range", PROTOCOL_FIELD_FOR_PROBLEM, "maxDays"],
  ] as const)("puts the API's %s words at their field", (code, map, field) => {
    expect(map[code]).toBe(field);
  });
});

describe("hazard HZ-120 a dose entered in error stays, struck through, with its reason", () => {
  const given = dose({ id: "d1", enteredInErrorBy: "d2" });
  const marking = dose({
    id: "d2",
    outcome: "entered_in_error",
    quantity: null,
    reason: null,
    supersedesId: "d1",
    correctionReason: "Recorded for the wrong person",
  });
  const standing = dose({ id: "d3" });

  it("lists each dose given with what marked it", () => {
    const rows = doseRows([standing, marking, given]);
    expect(rows.map((r) => [r.dose.id, r.correction?.correctionReason ?? null])).toEqual([
      ["d3", null],
      ["d1", "Recorded for the wrong person"],
    ]);
  });

  it.each([
    ["the giver", standing, [`medicines.emar.administer`], MEMBER, true],
    ["another giver", standing, [`medicines.emar.administer`], OTHER, false],
    ["a manager", standing, [`medicines.record.manage`], OTHER, true],
    ["anyone, once marked", given, [`medicines.record.manage`], MEMBER, false],
    ["anyone, the marking record", marking, [`medicines.record.manage`], MEMBER, false],
  ] as const)("%s", (_who, d, permissions, me, may) => {
    expect(mayMarkInError(d, { tenantUserId: me, permissions })).toBe(may);
  });

  it("needs a reason to mark a dose", () => {
    expect(readEnteredInError(form({ reason: "Wrong person" }), t, { id: "n1" })).toEqual({
      ok: true,
      body: { id: "n1", reason: "Wrong person" },
    });
    expect(readEnteredInError(form({ reason: "" }), t, { id: "n1" }).ok).toBe(false);
  });
});

describe("hazard HZ-120 the staff a protocol may name", () => {
  it("lists the staff, the reader and anyone already named who is not listed", () => {
    const options = memberOptions(
      [
        { id: OTHER, displayName: "Bea Example", jobTitle: "Senior carer" },
        { id: "z", displayName: "Al Example", jobTitle: null },
      ],
      { tenantUserId: MEMBER, name: "Cy Example" },
      ["gone", OTHER, "gone"],
      t,
    );
    expect(options.map((o) => o.id)).toEqual(["z", OTHER, MEMBER, "gone"]);
    expect(options[3]?.label).toBe("medicines.homely.member.unlisted");
  });

  it("does not list the reader twice", () => {
    const options = memberOptions(
      [{ id: MEMBER, displayName: "Cy Example" }],
      { tenantUserId: MEMBER, name: "Cy Example" },
      [],
      t,
    );
    expect(options).toEqual([{ id: MEMBER, label: "Cy Example" }]);
  });
});

describe("currentMedicines (hazard HZ-120)", () => {
  it.each([
    ["checked", true],
    ["not_yet_checked", true],
    ["difference_found", true],
    ["stopped", false],
    ["replaced", false],
    ["withdrawn", false],
  ] as const)("an entry that is %s is listed: %s", (state, listed) => {
    const out = currentMedicines([
      { state, product: { name: "Codeine 30mg tablets" }, directionsInWords: "1 tablet at 08:00" },
    ]);
    expect(out.length > 0).toBe(listed);
  });
});

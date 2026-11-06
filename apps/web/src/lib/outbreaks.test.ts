import type { Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  caseRowChip,
  outbreakStateChip,
  outbreaksShown,
  readCloseOutbreak,
  readDeclareOutbreak,
  readRecordCase,
  readUpdateOutbreak,
} from "./outbreaks";

/** Phase 2 slice 63: the pure parts of the outbreak screens (SAFE-013). */

// Returns the key: the assertions are about the readers and chips, not the wording.
const t = ((key: string) => key) as unknown as Translator;

const LOCATION = "0194d000-0000-7000-8000-000000000101";
const PERSON = "0194d000-0000-7000-8600-000000000001";

function form(values: Record<string, string | readonly string[]>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const v of typeof value === "string" ? [value] : value) data.append(key, v);
  }
  return data;
}
const date = (name: string, [d, m, y]: readonly string[]) => ({
  [`${name}-day`]: d ?? "",
  [`${name}-month`]: m ?? "",
  [`${name}-year`]: y ?? "",
});

describe("outbreaks", () => {
  it("is shown to holders of safety.outbreak.manage only", () => {
    expect(outbreaksShown(["safety.outbreak.manage"])).toBe(true);
    expect(outbreaksShown(["safety.incident.read"])).toBe(false);
  });

  it.each([
    ["declared", "overdue", "circle-alert"],
    ["closed", "neutral", "circle-check"],
    ["lost", "overdue", "triangle-alert"],
  ])("names state %s as an icon and a word (%s, %s)", (state, status, icon) => {
    const chip = outbreakStateChip(state, t);
    expect(chip).toMatchObject({ status, icon });
    expect(chip.label.length).toBeGreaterThan(0);
  });

  it("says in words whether a line-list row is current or superseded", () => {
    expect(caseRowChip(true, t)).toMatchObject({ status: "info", icon: "circle-check" });
    expect(caseRowChip(false, t)).toMatchObject({ status: "notApplicable", icon: "circle-minus" });
  });

  it.each([
    [{ locationId: LOCATION, syndrome: "flu" }, true],
    [{ locationId: LOCATION, syndrome: "flu", organism: "Influenza A" }, true],
    [{ locationId: LOCATION, syndrome: "flu", organism: "A" }, false],
    [{ locationId: LOCATION, syndrome: "plague" }, false],
    [{ locationId: "home", syndrome: "flu" }, false],
  ])("reads a declaration %j (ok: %s)", (values, ok) => {
    expect(readDeclareOutbreak(form(values), t).ok).toBe(ok);
  });

  it("sends nothing for an empty organism or reference", () => {
    expect(readDeclareOutbreak(form({ locationId: LOCATION, syndrome: "other" }), t)).toEqual({
      ok: true,
      body: { locationId: LOCATION, syndrome: "other" },
    });
    expect(
      readUpdateOutbreak(form({ organism: "", hptReference: "HPT 12" }), t, { version: 2 }),
    ).toEqual({
      ok: true,
      body: { version: 2, organism: null, hptReference: "HPT 12" },
    });
  });

  it("closes only with a real date and a reason", () => {
    expect(readCloseOutbreak(form({ reason: "Over." }), t, { version: 3 }).ok).toBe(false);
    expect(
      readCloseOutbreak(form({ ...date("closedOn", ["30", "10", "2026"]), reason: "" }), t, {
        version: 3,
      }).ok,
    ).toBe(false);
    expect(
      readCloseOutbreak(
        form({ ...date("closedOn", ["30", "10", "2026"]), reason: "The team agreed it is over." }),
        t,
        { version: 3 },
      ),
    ).toEqual({
      ok: true,
      body: { version: 3, closedOn: "2026-10-30", reason: "The team agreed it is over." },
    });
  });

  it("records a resident's row, and asks for the test when there is a result", () => {
    const base = {
      personId: PERSON,
      ...date("onsetOn", ["29", "10", "2026"]),
      symptoms: ["cough", "fever", "cough", "made_up"],
    };
    const read = readRecordCase(form(base), t);
    expect(read).toMatchObject({
      ok: true,
      body: {
        caseType: "resident",
        personId: PERSON,
        tenantUserId: null,
        onsetOn: "2026-10-29",
        symptoms: ["cough", "fever"],
        testResult: "not_tested",
        testType: null,
        outcome: "unwell",
        outcomeOn: null,
        fluVaccinated: "unknown",
      },
    });
    const noTest = readRecordCase(form({ ...base, testResult: "positive" }), t);
    expect(noTest.ok).toBe(false);
    if (!noTest.ok) expect(Object.keys(noTest.errors)).toEqual(["testType"]);
    const recovered = readRecordCase(form({ ...base, outcome: "recovered" }), t);
    expect(recovered.ok).toBe(false);
  });

  it("hazard HZ-013 a new row never supersedes anything", () => {
    const read = readRecordCase(
      form({ personId: PERSON, ...date("onsetOn", ["29", "10", "2026"]), symptoms: "cough" }),
      t,
    );
    expect(read).toMatchObject({ ok: true, body: { supersedesId: null, correctionReason: null } });
  });

  it("hazard HZ-013 updates or corrects a current row by superseding it, never as a second row", () => {
    const ROW = "0199f000-0000-7000-8000-0000000000c1";
    const base = {
      ...date("onsetOn", ["29", "10", "2026"]),
      symptoms: "cough",
      outcome: "recovered",
      ...date("outcomeOn", ["31", "10", "2026"]),
      // A person field sent with an update is ignored: the update stays with the row's person.
      personId: "0199f000-0000-7000-8000-0000000000ff",
    };
    const supersedes = { id: ROW, personId: PERSON };
    expect(readRecordCase(form(base), t, { supersedes }).ok).toBe(false);
    expect(readRecordCase(form({ ...base, change: "update" }), t, { supersedes })).toMatchObject({
      ok: true,
      body: { supersedesId: ROW, personId: PERSON, correctionReason: null, outcome: "recovered" },
    });
    const noReason = readRecordCase(form({ ...base, change: "correct" }), t, { supersedes });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(Object.keys(noReason.errors)).toEqual(["correctionReason"]);
    expect(
      readRecordCase(
        form({ ...base, change: "correct", correctionReason: "Wrong onset date." }),
        t,
        {
          supersedes,
        },
      ),
    ).toMatchObject({
      ok: true,
      body: { supersedesId: ROW, correctionReason: "Wrong onset date." },
    });
  });

  it("hazard HZ-013 closes with people still unwell only once the closer says they know", () => {
    const values = { ...date("closedOn", ["30", "10", "2026"]), reason: "Agreed with the team." };
    const unticked = readCloseOutbreak(form(values), t, { version: 3, stillUnwell: 2 });
    expect(unticked.ok).toBe(false);
    if (!unticked.ok) expect(Object.keys(unticked.errors)).toEqual(["knowStillUnwell"]);
    expect(
      readCloseOutbreak(form({ ...values, knowStillUnwell: "yes" }), t, {
        version: 3,
        stillUnwell: 2,
      }).ok,
    ).toBe(true);
    expect(readCloseOutbreak(form(values), t, { version: 3, stillUnwell: 0 }).ok).toBe(true);
  });

  it("refuses a row with no symptoms or no onset", () => {
    const read = readRecordCase(form({ personId: PERSON }), t);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(Object.keys(read.errors).sort()).toEqual(["onsetOn", "symptoms"]);
  });
});

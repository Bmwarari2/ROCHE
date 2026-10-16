import type { OutageItem } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  correctionBackEntry,
  insideOutage,
  PAPER_FIELDS,
  paperOutages,
  readEntryWhen,
} from "./back-entry";
import { problemMessage } from "./outcome";

const t = createTranslator("en-GB");
const NOW = new Date("2026-10-16T14:00:00Z");
const OUTAGE = "0194d000-0000-7000-8000-000000000999";

const outage = (over: Partial<OutageItem> = {}): OutageItem => ({
  id: OUTAGE,
  locationId: "0194d000-0000-7000-8000-000000000101",
  kind: "power",
  description: "Power cut",
  state: "closed",
  startedAt: "2026-10-16T08:00:00Z",
  endedAt: "2026-10-16T10:00:00Z",
  declaredAt: "2026-10-16T08:05:00Z",
  declaredBy: "0194d000-0000-7000-8000-000000000303",
  declaredLate: false,
  closedAt: "2026-10-16T10:05:00Z",
  closedBy: "0194d000-0000-7000-8000-000000000303",
  backEntryDueAt: "2026-10-17T10:05:00Z",
  reconciledAt: null,
  reconciledBy: null,
  reconciliationStatement: null,
  formsEntered: null,
  cancelledAt: null,
  cancelledBy: null,
  cancellationReason: null,
  correctionReason: null,
  version: 2,
  ...over,
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

/** The paper time boxes of the WhenField named occurredAt. */
const boxes = (day: string, hour: string, minute: string) => ({
  "occurredAt-day": day,
  "occurredAt-month": "10",
  "occurredAt-year": "2026",
  "occurredAt-hour": hour,
  "occurredAt-minute": minute,
});

describe("hazard HZ-017 entering a paper record from an outage on the care record forms", () => {
  it("offers only outages a paper record can still be entered against", () => {
    const list = [
      outage({ id: "a", state: "declared" }),
      outage({ id: "b", state: "closed" }),
      outage({ id: "c", state: "reconciled" }),
      outage({ id: "d", state: "cancelled" }),
    ];
    expect(paperOutages(list).map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("takes the window as [start, end), an open outage running on", () => {
    expect(insideOutage(outage(), "2026-10-16T08:00:00Z")).toBe(true);
    expect(insideOutage(outage(), "2026-10-16T10:00:00Z")).toBe(false);
    expect(insideOutage(outage({ endedAt: null }), "2026-10-16T13:00:00Z")).toBe(true);
  });

  it("asks for the outage and the time written on the form, nothing filled in", () => {
    const read = readEntryWhen(form({ "occurredAt-mode": "paper" }), "occurredAt", t, [outage()], {
      now: NOW,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.problems.map((p) => p.field)).toEqual(["outageId", "occurredAt"]);
    expect(read.problems[0]?.message).toBe("Choose the outage the paper form was written in");
  });

  it("sends the paper date and time as written, with its outage and reference", () => {
    const read = readEntryWhen(
      form({
        "occurredAt-mode": "paper",
        outageId: OUTAGE,
        paperReference: " DT-14 ",
        outsideOutageReason: "not needed inside the window",
        ...boxes("16", "9", "15"),
      }),
      "occurredAt",
      t,
      [outage()],
      { now: NOW },
    );
    expect(read).toEqual({
      ok: true,
      instant: "2026-10-16T08:15:00.000Z",
      downtime: {
        backEntry: {
          outageId: OUTAGE,
          paperDate: "2026-10-16",
          paperTime: "09:15",
          paperReference: "DT-14",
        },
      },
    });
  });

  it("asks why when the time on the form is outside the outage, and sends the reason", () => {
    const fields = { "occurredAt-mode": "paper", outageId: OUTAGE, ...boxes("16", "11", "30") };
    const refused = readEntryWhen(form(fields), "occurredAt", t, [outage()], { now: NOW });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.problems).toEqual([
        {
          field: "outsideOutageReason",
          message:
            "The time on the form is outside the outage (16/10/2026 09:00 to 16/10/2026 11:00). Say why in 10 characters or more.",
        },
      ]);
    }
    const reason = "Form dated after the power came back";
    const read = readEntryWhen(
      form({ ...fields, outsideOutageReason: reason }),
      "occurredAt",
      t,
      [outage()],
      { now: NOW },
    );
    expect(read.ok && read.downtime.backEntry?.outsideOutageReason).toBe(reason);
  });

  it("hazard HZ-009 says which of the repeated autumn times was written", () => {
    const autumn = outage({ startedAt: "2026-10-24T22:00:00Z", endedAt: "2026-10-25T03:00:00Z" });
    const fields = {
      "occurredAt-mode": "paper",
      outageId: OUTAGE,
      "occurredAt-day": "25",
      "occurredAt-month": "10",
      "occurredAt-year": "2026",
      "occurredAt-hour": "01",
      "occurredAt-minute": "30",
      "occurredAt-fold": "second",
    };
    const read = readEntryWhen(form(fields), "occurredAt", t, [autumn], {
      now: new Date("2026-10-25T12:00:00Z"),
    });
    expect(read.ok && read.instant).toBe("2026-10-25T01:30:00.000Z");
    expect(read.ok && read.downtime.backEntry?.occurrence).toBe("later");
  });

  it("sends why an entry in an outage is not from paper, once the API has asked", () => {
    const read = readEntryWhen(
      form({ "occurredAt-mode": "now", notFromPaperReason: " Remembered at handover " }),
      "occurredAt",
      t,
      [outage()],
      { now: NOW },
    );
    expect(read).toEqual({
      ok: true,
      instant: NOW.toISOString(),
      downtime: { notFromPaperReason: "Remembered at handover" },
    });
  });

  it("lists the paper fields for the error summary", () => {
    expect(PAPER_FIELDS).toEqual([
      "outageId",
      "paperReference",
      "outsideOutageReason",
      "notFromPaperReason",
    ]);
  });
});

describe("hazard HZ-017 corrections and refusals of paper records (H-204, H-208, H-216)", () => {
  it("sends the paper details again, as written, with the reason the time is outside", () => {
    expect(
      correctionBackEntry(
        {
          outageId: OUTAGE,
          paperDate: "2026-10-16",
          paperTime: "10:30",
          occurrence: "only",
          outsideOutageReason: null,
          paperReference: "DT-3",
          label: "label",
        },
        " Written after the lights came back ",
      ),
    ).toEqual({
      outageId: OUTAGE,
      paperDate: "2026-10-16",
      paperTime: "10:30",
      paperReference: "DT-3",
      outsideOutageReason: "Written after the lights came back",
    });
  });

  it.each([
    [
      "back_entry_details_required",
      "This time falls in the outage from 16/10/2026 09:00. If you are copying a paper form, enter it as a back-entry; if not, say why it was not written on paper.",
      "notFromPaperReason",
    ],
    [
      "outside_outage_reason_required",
      "This paper record's time is after the outage ended at 16/10/2026 11:00. Say why.",
      "outsideOutageReason",
    ],
  ])("puts the API's words for %s at the field they are about", (code, detail, field) => {
    expect(problemMessage({ code, detail }, t)).toEqual({
      code,
      message: detail,
      fields: { [field]: detail },
    });
  });

  it("hazard HZ-006 says a record for a reconciled outage is kept for the nurse in charge", () => {
    const detail =
      "This outage has been reconciled, so this paper record cannot be added to it. It has been kept for the nurse in charge to review: give the paper form to the Registered Manager.";
    expect(problemMessage({ code: "outage_reconciled", detail }, t)).toEqual({
      code: "outage_reconciled",
      message: detail,
    });
  });

  it("says a paper record is corrected once: reload and correct the current version", () => {
    expect(problemMessage({ code: "back_entry_already_corrected" }, t).message).toBe(
      "This paper record has been corrected already. Reload the page and correct the current version.",
    );
  });
});

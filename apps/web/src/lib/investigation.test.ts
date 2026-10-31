import type { InvestigationItem } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  actionDue,
  actionStatusChip,
  investigationManageable,
  investigationStatusChip,
  readFactors,
  readInvestigationForm,
  staffName,
  staffOptions,
} from "./investigation";

const t = createTranslator("en-GB");
const ME = "0194d000-0000-7000-8000-00000000a002";
const NURSE = "0194d000-0000-7000-8000-00000000a003";
const OTHER = "0194d000-0000-7000-8000-00000000a004";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(entries)) data.append(name, value);
  return data;
}

function investigation(overrides: Partial<InvestigationItem> = {}): InvestigationItem {
  return {
    id: "0194d000-0000-7000-8000-00000000b001",
    incidentId: "0194d000-0000-7000-8000-00000000e001",
    leadTenantUserId: ME,
    method: "five_whys",
    findings: null,
    contributingFactors: [],
    actions: [
      {
        id: "0194d000-0000-7000-8000-00000000f001",
        action: "Check every hoist sling for wear.",
        ownerTenantUserId: NURSE,
        dueOn: "2026-11-01",
        status: "open",
        taskId: "0194d000-0000-7000-8000-00000000f101",
      },
    ],
    lessons: null,
    bulletinPublishedAt: null,
    status: "open",
    completedAt: null,
    version: 2,
    ...overrides,
  };
}

describe("investigation status in words and icons", () => {
  it.each([
    ["open", "info", "search", "In progress"],
    ["completed", "done", "circle-check", "Completed"],
    ["paused", "overdue", "triangle-alert", "Status not known"],
  ])("says %s with an icon, and an unknown one warns", (status, chip, icon, label) => {
    expect(investigationStatusChip(status, t)).toEqual({ status: chip, icon, label });
  });

  it.each([
    [{ status: "open", dueOn: "2026-11-01" }, "2026-10-31", "due", "Open"],
    [{ status: "open", dueOn: "2026-10-30" }, "2026-10-31", "overdue", "Open: past its date"],
    [{ status: "open", dueOn: null }, "2026-10-31", "due", "Open"],
    [{ status: "done", dueOn: "2026-10-30" }, "2026-10-31", "done", "Done"],
    [{ status: "cancelled", dueOn: null }, "2026-10-31", "notApplicable", "Cancelled"],
  ] as const)("hazard HZ-091 says an action %j on %s as %s", (action, today, status, label) => {
    expect(actionStatusChip(action, today, t)).toMatchObject({ status, label });
  });

  it("says when an action is due, dd/mm/yyyy", () => {
    expect(actionDue("2026-12-01", t)).toBe("Due 01/12/2026");
    expect(actionDue(null, t)).toBe("No date set");
  });
});

describe("staff in words", () => {
  const names = new Map([[NURSE, "Nell Example"]]);

  it("names staff only from the reader's own list, else you or a colleague, never an id", () => {
    expect(staffName(ME, ME, names, t)).toBe("You");
    expect(staffName(NURSE, ME, names, t)).toBe("Nell Example");
    expect(staffName(OTHER, ME, names, t)).toBe("A colleague");
    expect(staffName(null, ME, names, t)).toBe("No one chosen yet");
  });

  it("offers the reader first, then the team, and keeps anyone already chosen", () => {
    expect(
      staffOptions(
        ME,
        [
          { id: NURSE, displayName: "Nell Example" },
          { id: ME, displayName: "Mo" },
        ],
        [OTHER, null],
        t,
      ),
    ).toEqual([
      { value: ME, label: "You" },
      { value: NURSE, label: "Nell Example" },
      { value: OTHER, label: "A colleague" },
    ]);
  });

  it("offers the form to a manager on an incident seen whole, closed or not", () => {
    expect(investigationManageable({ restricted: false }, ["safety.incident.manage"])).toBe(true);
    expect(investigationManageable({ restricted: true }, ["safety.incident.manage"])).toBe(false);
    expect(investigationManageable({ restricted: false }, ["safety.incident.read"])).toBe(false);
  });
});

describe("readInvestigationForm", () => {
  const staff = [ME, NURSE];

  it("keeps each action's words, owner and date, so its task stays theirs, and reads its status", () => {
    const read = readInvestigationForm(
      form({
        lead: ME,
        method: "fishbone",
        "action-0-status": "done",
        factors: "Staffing\n\n Equipment ",
      }),
      investigation(),
      staff,
      "open",
      t,
    );
    expect(read).toMatchObject({
      ok: true,
      input: {
        leadTenantUserId: ME,
        method: "fishbone",
        contributingFactors: ["Staffing", "Equipment"],
        actions: [
          {
            id: "0194d000-0000-7000-8000-00000000f001",
            action: "Check every hoist sling for wear.",
            ownerTenantUserId: NURSE,
            dueOn: "2026-11-01",
            status: "done",
          },
        ],
        bulletinPublished: false,
        status: "open",
      },
    });
  });

  it("adds one new action with its owner and date", () => {
    const read = readInvestigationForm(
      form({
        newAction: "Replace the frayed sling.",
        newOwner: NURSE,
        "newDueOn-day": "1",
        "newDueOn-month": "12",
        "newDueOn-year": "2026",
      }),
      null,
      staff,
      "open",
      t,
    );
    expect(read).toMatchObject({
      ok: true,
      input: {
        leadTenantUserId: null,
        method: null,
        actions: [
          {
            action: "Replace the frayed sling.",
            ownerTenantUserId: NURSE,
            dueOn: "2026-12-01",
            status: "open",
          },
        ],
      },
    });
  });

  it("hazard HZ-091 needs the findings and the lessons to complete it, as the API checks", () => {
    const read = readInvestigationForm(form({}), investigation(), staff, "completed", t);
    expect(read).toEqual({
      ok: false,
      errors: {
        findings: "Record the findings before completing it",
        lessons: "Record the lessons before completing it",
      },
    });
    const done = readInvestigationForm(
      form({ findings: "The sling was worn.", lessons: "Check slings weekly." }),
      investigation(),
      staff,
      "completed",
      t,
    );
    expect(done).toMatchObject({ ok: true, input: { status: "completed" } });
  });

  it("needs the lessons to mark a bulletin published", () => {
    const read = readInvestigationForm(
      form({ bulletin: "yes" }),
      investigation(),
      staff,
      "open",
      t,
    );
    expect(read.ok).toBe(false);
    if (!read.ok)
      expect(read.errors.lessons).toBe("Record the lessons before marking them published");
  });

  it("refuses someone not offered, an owner or date without an action, and a date that is not real", () => {
    const read = readInvestigationForm(
      form({
        lead: OTHER,
        newOwner: NURSE,
        "newDueOn-day": "31",
        "newDueOn-month": "2",
        "newDueOn-year": "2026",
      }),
      null,
      staff,
      "open",
      t,
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(Object.keys(read.errors).sort()).toEqual(["lead", "newAction", "newDueOn"]);
    expect(read.parts?.newDueOn).toBeDefined();
  });

  it("limits the factors to 30 lines of at most 500 characters", () => {
    expect(readFactors("")).toEqual([]);
    expect(readFactors(Array.from({ length: 31 }, (_, i) => `F${i}`).join("\n"))).toBeNull();
    expect(readFactors("x".repeat(501))).toBeNull();
  });
});

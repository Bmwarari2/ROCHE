import type { StatutoryNotificationSummary } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  citationLine,
  deadlineLines,
  hasHiddenSubjects,
  notificationGroups,
  notificationSource,
  notificationSubject,
} from "./statutory-notifications";

const t = createTranslator("en-GB");
const PERSON = "0194d000-0000-7000-8600-000000000003";
const HIDDEN = "0194d000-0000-7000-8600-000000000005";
const INCIDENT = "0194d000-0000-7000-8700-000000000001";
const DOLS = "0194d000-0000-7000-8800-000000000001";
const names = new Map([[PERSON, "Cara Placeholder"]]);

type Item = Pick<StatutoryNotificationSummary, "id" | "clock" | "dueAt">;
const item = (id: string, clock: string, dueAt: string) =>
  ({ id, clock, dueAt }) as unknown as Item;

describe("the statutory notification pages (safety.md section 5; HZ-013)", () => {
  it("hazard HZ-013 puts what is still to do first: unknown clocks, overdue, due soonest, then done", () => {
    const groups = notificationGroups([
      item("done-early", "done", "2026-10-01T09:00:00Z"),
      item("due-late", "due", "2026-10-20T09:00:00Z"),
      item("due-soon", "due", "2026-10-13T09:00:00Z"),
      item("overdue", "overdue", "2026-10-12T09:00:00Z"),
      item("unknown", "paused", "2026-10-30T09:00:00Z"),
    ]);
    expect(groups.todo.map((n) => n.id)).toEqual(["unknown", "overdue", "due-soon", "due-late"]);
    expect(groups.done.map((n) => n.id)).toEqual(["done-early"]);
  });

  it.each([
    [
      "an incident",
      { incidentId: INCIDENT, personId: PERSON, dolsAuthorisationId: null },
      { source: "incident", id: INCIDENT, href: `/incidents/${INCIDENT}` },
    ],
    [
      "a DoLS outcome",
      { incidentId: null, personId: PERSON, dolsAuthorisationId: DOLS },
      { source: "dols", id: PERSON, href: `/people/${PERSON}/dols` },
    ],
    [
      "a person's record",
      { incidentId: null, personId: PERSON, dolsAuthorisationId: null },
      { source: "person", id: PERSON, href: `/people/${PERSON}` },
    ],
    ["nothing", { incidentId: null, personId: null, dolsAuthorisationId: null }, null],
  ])("names the record a notification drafted on %s came from", (_, input, expected) => {
    expect(notificationSource(input)).toEqual(expected);
  });

  it("hazard HZ-013 keeps every deadline in the law's terms, done or not, with a machine-readable time", () => {
    const lines = deadlineLines(
      {
        dueAt: "2026-10-12T13:05:00Z",
        deadlines: [
          {
            key: "notify_without_delay",
            dueAt: "2026-10-12T13:05:00Z",
            wording: "",
            statutory: true,
          },
          { key: "report_received", dueAt: "2026-10-22T13:05:00Z", wording: "", statutory: true },
        ],
      },
      t,
    );
    expect(lines).toEqual([
      {
        text: "Tell the enforcing authority without delay: the clock started 12/10/2026 14:05",
        dateTime: "2026-10-12T13:05:00Z",
      },
      {
        text: "The report must be received by 22/10/2026 14:05",
        dateTime: "2026-10-22T13:05:00Z",
      },
    ]);
  });

  it("hazard HZ-013 falls back to the due time, and warns when a time cannot be read", () => {
    expect(deadlineLines({ dueAt: "2026-01-05T09:30:00Z", deadlines: [] }, t)).toEqual([
      { text: "Due by 05/01/2026 09:30", dateTime: "2026-01-05T09:30:00Z" },
    ]);
    expect(deadlineLines({ dueAt: "not a time", deadlines: [] }, t)).toEqual([
      { text: "Due time not known", dateTime: null },
    ]);
  });

  it("hazard HZ-001 says who a notification is about, never numbering one person on their own page", () => {
    expect(notificationSubject({ personId: PERSON }, names, t)).toBe("About Cara Placeholder");
    expect(notificationSubject({ personId: HIDDEN }, names, t)).toBe(
      "About a person we support (not shown to you)",
    );
    expect(notificationSubject({ personId: null }, names, t)).toBeNull();
  });

  it("says when a list numbers people the reader cannot see", () => {
    expect(hasHiddenSubjects([{ personId: PERSON }, { personId: null }], names)).toBe(false);
    expect(hasHiddenSubjects([{ personId: PERSON }, { personId: HIDDEN }], names)).toBe(true);
  });

  it.each([
    ["https://www.legislation.gov.uk/uksi/2009/3112/regulation/18", true],
    ["http://example.invalid/regulation", false],
    ["javascript:alert(1)", false],
    ["https://example.invalid/a page", false],
  ])("links a source only when its address is https: %s", (url, linked) => {
    const line = citationLine(
      { source: "CQC Regulations 2009", provision: "regulation 18", url },
      t,
    );
    expect(line.text).toBe("CQC Regulations 2009: regulation 18");
    expect(line.href).toBe(linked ? url : null);
  });
});

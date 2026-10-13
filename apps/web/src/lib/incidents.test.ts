import { HarmGrade, IncidentSeverity, IncidentType } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  INCIDENT_LIST_LIMIT,
  incidentNotices,
  incidentPersonFacts,
  incidentPersonLine,
  incidentStatusChip,
  incidentsNavLabel,
  incidentsToList,
  incidentTitle,
} from "./incidents";

const t = createTranslator("en-GB");
const PERSON = "0194d000-0000-7000-8600-000000000003";

describe("incidents in the list and on the page (safety.md; HZ-013)", () => {
  it.each([
    ["open", "due", "clock", "Open"],
    ["under_review", "info", "search", "Under review"],
    ["closed", "done", "circle-check", "Closed"],
    ["archived", "overdue", "circle-alert", "Status not known"],
  ])(
    "hazard HZ-013 says the status %s in words with an icon, and an unknown one warns",
    (status, tone, icon, label) => {
      expect(incidentStatusChip(status, t)).toEqual({ status: tone, icon, label });
    },
  );

  it("names the incident by its type and when it happened, in UK time", () => {
    expect(incidentTitle({ type: "fall", occurredAt: "2026-10-12T13:05:00Z" }, t)).toBe(
      "Fall, 12/10/2026 14:05",
    );
  });

  it("has words for every type, severity and harm grade the API can send", () => {
    for (const type of IncidentType.options) {
      expect(t("safety.incident.type", { type }), type).not.toMatch(/does not recognise/);
    }
    for (const severity of IncidentSeverity.options) {
      expect(t("safety.incident.severity", { severity }), severity).not.toBe("Could not be read");
    }
    for (const harm of HarmGrade.options) {
      expect(t("safety.incident.harm", { harm }), harm).not.toBe("Could not be read");
    }
  });

  it("names someone on an incident by the name in scope, the name recorded, or their kind", () => {
    const names = new Map([[PERSON, "Cara Placeholder"]]);
    const person = {
      kind: "service_user",
      role: "affected",
      personId: PERSON,
      otherName: null,
    } as const;
    expect(incidentPersonLine(person, names, t)).toBe("Cara Placeholder: affected");
    expect(
      incidentPersonLine(
        {
          ...person,
          personId: null,
          otherName: "Vic Visitor",
          kind: "other_not_at_work",
          role: "witness",
        },
        names,
        t,
      ),
    ).toBe("Vic Visitor: witness");
    expect(incidentPersonLine({ ...person, kind: "worker", personId: null }, names, t)).toBe(
      "A member of staff: affected",
    );
    expect(incidentPersonLine(person, new Map(), t)).toBe("A person we support: affected");
  });

  it("says what was recorded about someone, and nothing when nothing was", () => {
    const none = {
      died: false,
      learningDisability: null,
      autistic: false,
      subjectToMentalHealthAct: null,
      bodyMapMarkIds: [],
    };
    expect(incidentPersonFacts(none, t)).toEqual([]);
    expect(
      incidentPersonFacts(
        {
          died: true,
          learningDisability: true,
          autistic: true,
          subjectToMentalHealthAct: true,
          bodyMapMarkIds: [PERSON, PERSON],
        },
        t,
      ),
    ).toEqual([
      "Died",
      "Has a learning disability",
      "Autistic",
      "Subject to the Mental Health Act",
      "2 body map marks",
    ]);
  });
});

describe("what the incident screens leave out, said in words (#42 review; HZ-013)", () => {
  const incident = (id: string, occurredAt: string) => ({ id, occurredAt });
  const many = Array.from({ length: INCIDENT_LIST_LIMIT }, (_, n) =>
    incident(`new-${n}`, new Date(Date.UTC(2026, 9, 12, 12, 0, -n)).toISOString()),
  );

  it("hazard HZ-013 adds older open and under-review incidents to a list cut at the limit, and says so", () => {
    const older = incident("older-open", "2026-01-02T09:00:00Z");
    const result = incidentsToList(many, [older, many[0] as (typeof many)[number]], []);
    expect(result.truncated).toBe("older");
    expect(result.items).toHaveLength(INCIDENT_LIST_LIMIT + 1);
    expect(result.items.at(-1)).toBe(older);
    expect(result.items[0]?.id).toBe("new-0");
    expect(incidentsToList(many.slice(1), []).truncated).toBeNull();
    expect(t("safety.incidents.truncated", { reach: "older", limit: INCIDENT_LIST_LIMIT })).toBe(
      "Older incidents are not listed. This list shows the newest 500 and every open or under-review incident.",
    );
  });

  it("hazard HZ-013 never promises every open incident when the open list itself hit the limit", () => {
    expect(incidentsToList(many, [], many).truncated).toBe("unfinished");
    expect(t("safety.incidents.truncated", { reach: "unfinished", limit: 500 })).toBe(
      "Not every incident is listed: there are more than 500 open or under-review incidents, and older ones are left out.",
    );
  });

  it.each<
    [string, { restricted: boolean; classifier: { nationSupported: boolean } | null }, string[]]
  >([
    ["restricted", { restricted: true, classifier: null }, []],
    [
      "not checked yet",
      { restricted: false, classifier: null },
      ["Statutory notifications not checked yet"],
    ],
    [
      "outside England",
      { restricted: false, classifier: { nationSupported: false } },
      [
        "Statutory notifications are not checked outside England",
        "This page does not show the questions or statutory notifications yet",
      ],
    ],
    [
      "checked",
      { restricted: false, classifier: { nationSupported: true } },
      ["This page does not show the questions or statutory notifications yet"],
    ],
  ])("hazard HZ-013 says what the incident page does not show: %s", (_, value, titles) => {
    const notices = incidentNotices(value, false, t);
    expect(notices.map((n) => n.title)).toEqual(titles);
    expect(notices.every((n) => n.body.length > 0)).toBe(true);
  });

  it("tells a holder of safety.notification.submit to check, not to ask themselves", () => {
    const hints = (canSubmit: boolean) =>
      incidentNotices({ restricted: false, classifier: null }, canSubmit, t).map((n) => n.body);
    expect(hints(false)).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Ask a nurse or the Registered Manager to check it.",
    ]);
    expect(hints(true)).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Until it has, check what the law needs for this incident yourself.",
    ]);
    const shown = incidentNotices(
      { restricted: false, classifier: { nationSupported: true } },
      true,
      t,
    );
    expect(shown.map((n) => n.body)).toEqual([
      "Until this page shows them, check this incident's statutory notifications and questions yourself.",
    ]);
  });

  it("words the questions, the people and the title so nothing hidden reads as none", () => {
    expect(t("safety.incident.questionsChip", { count: 2 })).toBe(
      "2 questions about statutory notifications to answer",
    );
    expect(t("safety.incident.noPeople", { restricted: "true" })).toBe(
      "You cannot see the people on this incident",
    );
    expect(t("safety.incident.noPeople", { restricted: "false" })).toBe(
      "No one is recorded on this incident",
    );
    expect(t("safety.incident.pageTitle", { dateTime: "12/10/2026 14:05" })).toBe(
      "Incident, 12/10/2026 14:05",
    );
    expect(t("safety.incident.pageTitle", { dateTime: "none" })).toBe("Incident");
  });

  it("offers the Incidents item only to holders of safety.incident.read", () => {
    expect(incidentsNavLabel(["safety.incident.read"], t)).toBe("Incidents");
    expect(incidentsNavLabel(["safety.incident.report", "people.person.read"], t)).toBeUndefined();
  });
});

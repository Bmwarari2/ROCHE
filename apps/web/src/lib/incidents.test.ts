import { HarmGrade, IncidentSeverity, IncidentType } from "@harbour/contracts";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  incidentPersonFacts,
  incidentPersonLine,
  incidentStatusChip,
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

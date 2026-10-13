import type { ClassifierView, StatutoryNotificationSummary } from "@harbour/contracts";
import { HarmGrade, IncidentSeverity, IncidentType } from "@harbour/contracts";
import { NOTIFICATION_KINDS, STATUTORY_NOTIFICATION_KINDS } from "@harbour/domain";
import { createTranslator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  INCIDENT_LIST_LIMIT,
  incidentPersonFacts,
  incidentPersonLine,
  incidentStatusChip,
  incidentsNavLabel,
  incidentsToList,
  incidentTitle,
  notificationClockChip,
  notificationKindLabel,
  notificationsInOrder,
  notificationsView,
  notificationWarnings,
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

describe("statutory notifications on an incident (safety.md section 4; HZ-013)", () => {
  const draft = (over: Partial<StatutoryNotificationSummary> = {}) =>
    ({
      kind: "cqc_reg18_police",
      status: "draft",
      clock: "overdue",
      dueAt: "2026-10-12T13:05:00Z",
      provisional: false,
      noLongerIndicated: false,
      statutory: true,
      ...over,
    }) as const;

  it.each([
    ["overdue", "draft", "overdue", "circle-alert", "Overdue"],
    ["due", "ready", "due", "clock", "Due"],
    ["done", "submitted", "done", "circle-check", "Submitted"],
    ["done", "not_required", "done", "circle-check", "Not required"],
    ["paused", "draft", "overdue", "triangle-alert", "Clock not known"],
  ])(
    "hazard HZ-013 shows the %s clock of a %s draft with an icon and a word; an unknown clock warns",
    (clock, status, tone, icon, label) => {
      expect(notificationClockChip({ clock, status } as never, t)).toEqual({
        status: tone,
        icon,
        label,
      });
    },
  );

  it("hazard HZ-013 puts overdue first, then the soonest due, then those done", () => {
    const items = [
      draft({ clock: "done", dueAt: "2026-10-10T09:00:00Z" }),
      draft({ clock: "due", dueAt: "2026-10-14T09:00:00Z" }),
      draft({ clock: "due", dueAt: "2026-10-13T09:00:00Z" }),
      draft({ clock: "overdue", dueAt: "2026-10-12T09:00:00Z" }),
    ];
    expect(notificationsInOrder(items).map((n) => `${n.clock} ${n.dueAt.slice(8, 10)}`)).toEqual([
      "overdue 12",
      "due 13",
      "due 14",
      "done 10",
    ]);
  });

  it("hazard HZ-013 warns on a provisional draft, one no longer indicated and a Harbour target", () => {
    expect(notificationWarnings(draft(), t)).toEqual([]);
    expect(notificationWarnings(draft({ provisional: true, statutory: false }), t)).toEqual([
      "Provisional: it rests on an answer of not sure",
      "This time is Harbour's target, not a legal deadline",
    ]);
    // The API keeps the draft provisional after a later "no"; it no longer rests on "not sure".
    expect(notificationWarnings(draft({ provisional: true, noLongerIndicated: true }), t)).toEqual([
      "The answers no longer show this is needed. Someone who can submit notifications must decide whether it is not required.",
    ]);
  });

  it("names every kind and its recipient in the catalogue, as the domain names them", () => {
    for (const kind of STATUTORY_NOTIFICATION_KINDS) {
      const info = NOTIFICATION_KINDS[kind];
      expect(notificationKindLabel(kind, t), kind).toBe(info.label);
      expect(t("safety.notification.recipient", { kind }).toLowerCase(), kind).toContain(
        info.recipient.toLowerCase().replace(/^the /, ""),
      );
    }
    expect(notificationKindLabel("cqc_reg99", t)).toBe(
      "Notification of a kind Harbour does not recognise",
    );
  });

  type View = Pick<
    ClassifierView,
    "nationSupported" | "openQuestions" | "pending" | "notifications"
  >;
  const view = (over: Partial<View> = {}): View => ({
    nationSupported: true,
    openQuestions: [],
    pending: [],
    notifications: [],
    ...over,
  });
  const question = { key: "police.involved" } as View["openQuestions"][number];

  it.each<[string, View | null, string[], string[], string | null]>([
    ["not checked yet", null, ["Notifications not checked yet"], [], null],
    [
      "outside England",
      view({ nationSupported: false }),
      ["Notifications are not checked outside England"],
      [],
      null,
    ],
    [
      "questions open, a kind waiting",
      view({
        openQuestions: [question, question],
        pending: [{ kind: "cqc_reg18_police", waitingFor: ["police.involved"] }],
      }),
      ["2 questions to answer before Harbour can say which notifications are needed"],
      ["May be needed once they are answered: Incident reported to or investigated by the police"],
      null,
    ],
    ["drafts made", view({ notifications: [draft() as never] }), [], [], null],
    [
      "nothing open or drafted",
      view(),
      [],
      [],
      "Harbour found no statutory notification to make on what is recorded so far",
    ],
  ])(
    "hazard HZ-013 never says none are needed while anything is open: %s",
    (_, classifier, notices, pending, none) => {
      const result = notificationsView(classifier, false, t);
      expect(result.notices.map((n) => n.title)).toEqual(notices);
      expect(result.notices.every((n) => n.body.length > 0)).toBe(true);
      expect(result.pending).toEqual(pending);
      expect(result.none).toBe(none);
    },
  );

  it("tells a holder of safety.notification.submit to check, not to ask themselves", () => {
    const hint = (classifier: View | null, canSubmit: boolean) =>
      notificationsView(classifier, canSubmit, t).notices.map((n) => n.body);
    expect(hint(null, false)).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Ask a nurse or the Registered Manager to check it.",
    ]);
    expect(hint(null, true)).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Until it has, check what the law needs for this incident yourself.",
    ]);
    expect(hint(view({ openQuestions: [question] }), false)).toEqual([
      "A nurse or the Registered Manager needs to answer them.",
    ]);
    expect(hint(view({ openQuestions: [question] }), true)).toEqual([
      "Until you can answer them on this page, check what the law needs for this incident yourself.",
    ]);
  });
});

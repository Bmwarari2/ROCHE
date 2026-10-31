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
  notificationDueLines,
  notificationKindLabel,
  notificationStatusChip,
  notificationSubjects,
  notificationsInOrder,
  notificationsView,
  notificationWarnings,
  overdueCount,
  showsPostFallCard,
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
  const NOW = new Date("2026-10-12T16:05:00Z");
  const draft = (over: Partial<StatutoryNotificationSummary> = {}) =>
    ({
      id: "n1",
      kind: "cqc_reg18_police",
      status: "draft",
      clock: "overdue",
      dueAt: "2026-10-12T13:05:00Z",
      provisional: false,
      noLongerIndicated: false,
      statutory: true,
      personId: null,
      ...over,
    }) as const;
  const chip = (over: Partial<StatutoryNotificationSummary>) =>
    notificationClockChip(draft(over) as never, NOW, t);

  it.each([
    ["overdue", "draft", "2026-10-12T13:05:00Z", "overdue", "circle-alert", "Overdue for 3 hours"],
    ["overdue", "draft", "2026-10-09T13:05:00Z", "overdue", "circle-alert", "Overdue for 3 days"],
    ["overdue", "draft", "2026-10-12T16:04:00Z", "overdue", "circle-alert", "Overdue for 1 minute"],
    ["due", "ready", "2026-10-20T09:00:00Z", "due", "clock", "Due"],
    ["done", "submitted", "2026-10-10T09:00:00Z", "done", "circle-check", "Submitted"],
    [
      "done",
      "not_required",
      "2026-10-10T09:00:00Z",
      "notApplicable",
      "circle-minus",
      "Not required",
    ],
    ["done", "withdrawn", "2026-10-10T09:00:00Z", "overdue", "triangle-alert", "Status not known"],
    ["paused", "draft", "2026-10-10T09:00:00Z", "overdue", "triangle-alert", "Clock not known"],
  ])(
    "hazard HZ-013 shows a %s clock on a %s notification due %s as an icon and a word",
    (clock, status, dueAt, tone, icon, label) => {
      expect(chip({ clock, status, dueAt } as never)).toEqual({ status: tone, icon, label });
    },
  );

  it.each([
    ["draft", "neutral", "file-pen", "Draft"],
    ["ready", "info", "send", "Ready to submit"],
    ["queued", "overdue", "triangle-alert", "Status not known"],
  ])(
    "hazard HZ-013 shows a %s notification still open as its own chip, never run on into the clock",
    (status, tone, icon, label) => {
      expect(notificationStatusChip(draft({ status } as never), t)).toEqual({
        status: tone,
        icon,
        label,
      });
      expect(notificationStatusChip(draft({ status: "submitted", clock: "done" }), t)).toBeNull();
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

  type Output = ClassifierView["outputs"][number];
  const output = (over: Partial<Output>): Output => ({
    kind: "cqc_reg18_police",
    dueAt: "2026-10-12T13:05:00Z",
    deadlines: [],
    reasons: [],
    provisional: false,
    requiredContent: [],
    ...over,
  });

  it("hazard HZ-013 says a without-delay notification's legal wording and when its clock started", () => {
    const outputs = [
      output({
        deadlines: [
          { key: "without_delay", dueAt: "2026-10-12T13:05:00Z", wording: "", statutory: true },
        ],
      }),
    ];
    expect(notificationDueLines(draft(), outputs, t)).toEqual([
      {
        text: "Without delay: the clock started 12/10/2026 14:05",
        dateTime: "2026-10-12T13:05:00Z",
      },
    ]);
  });

  it("hazard HZ-013 says candour's spoken step is as soon as reasonably practicable from when the clock started", () => {
    const candour = output({
      kind: "candour",
      deadlines: [
        { key: "verbal_notification", dueAt: "2026-10-12T13:05:00Z", wording: "", statutory: true },
        {
          key: "written_notification_target",
          dueAt: "2026-10-23T17:00:00Z",
          wording: "",
          statutory: false,
        },
      ],
    });
    expect(
      notificationDueLines(draft({ kind: "candour" }), [candour], t).map((line) => line.text),
    ).toEqual([
      "Tell the person, with an apology, as soon as reasonably practicable: the clock started 12/10/2026 14:05",
      "Written notification: Harbour's target by 23/10/2026 18:00",
    ]);
  });

  it("hazard HZ-013 shows RIDDOR's second deadline, and no deadline once a notification is done", () => {
    const riddor = output({
      kind: "riddor_specified_injury",
      deadlines: [
        {
          key: "notify_without_delay",
          dueAt: "2026-10-12T13:05:00Z",
          wording: "",
          statutory: true,
        },
        { key: "report_received", dueAt: "2026-10-22T13:05:00Z", wording: "", statutory: true },
      ],
    });
    const item = draft({ kind: "riddor_specified_injury" });
    expect(notificationDueLines(item, [riddor], t).map((line) => line.text)).toEqual([
      "Tell the enforcing authority without delay: the clock started 12/10/2026 14:05",
      "The report must be received by 22/10/2026 14:05",
    ]);
    expect(notificationDueLines({ ...item, clock: "done" }, [riddor], t)).toEqual([]);
  });

  it("hazard HZ-013 says Due by when the classifier gave no deadline, and warns when the time is unreadable", () => {
    expect(notificationDueLines(draft({ clock: "due" }), [], t)).toEqual([
      { text: "Due by 12/10/2026 14:05", dateTime: "2026-10-12T13:05:00Z" },
    ]);
    expect(notificationDueLines(draft({ dueAt: "not a time" }), [], t)).toEqual([
      { text: "Due time not known", dateTime: null },
    ]);
  });

  it("hazard HZ-009 tells the two 01:30s apart on the night the clocks go back", () => {
    const lines = ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"].map(
      (dueAt) => notificationDueLines(draft({ clock: "due", dueAt }), [], t)[0]?.text,
    );
    expect(lines[0]).not.toBe(lines[1]);
    expect(lines).toEqual(["Due by 25/10/2026 01:30 BST", "Due by 25/10/2026 01:30 GMT"]);
  });

  it("hazard HZ-013 gives each warning on a draft still open its next step", () => {
    expect(notificationWarnings(draft(), null, t)).toEqual([]);
    expect(notificationWarnings(draft({ provisional: true }), null, t)).toEqual([
      "Provisional: it rests on an answer of not sure. Someone who can submit notifications confirms it or marks it not required. If in doubt, notify.",
    ]);
    // The API keeps the draft provisional after a later "no"; it no longer rests on "not sure".
    expect(
      notificationWarnings(draft({ provisional: true, noLongerIndicated: true }), null, t),
    ).toEqual([
      "The answers no longer show this is needed. Someone who can submit notifications must decide whether it is not required.",
    ]);
    expect(
      notificationWarnings(draft({ kind: "safeguarding_s42", statutory: false }), null, t),
    ).toEqual([
      "This time is Harbour's target, not a legal deadline: make it as soon as possible all the same.",
    ]);
    expect(notificationWarnings(draft({ kind: "leder", statutory: false }), null, t)).toEqual([
      "This time is Harbour's target, not a legal deadline.",
    ]);
  });

  it("hazard HZ-013 says a draft waiting for answers is waiting, without inviting a not-required decision", () => {
    expect(notificationWarnings(draft({ noLongerIndicated: true }), 2, t)).toEqual([
      "Waiting for the answers to 2 questions before Harbour can say whether this is still needed",
    ]);
  });

  it("hazard HZ-013 puts no warnings on a notification that is finished", () => {
    for (const status of ["submitted", "not_required"] as const) {
      const done = draft({ status, clock: "done", provisional: true, noLongerIndicated: true });
      expect(notificationWarnings({ ...done, statutory: false }, 1, t)).toEqual([]);
    }
  });

  it("hazard HZ-013 names every kind and its recipient in the catalogue, as the domain names them", () => {
    for (const kind of STATUTORY_NOTIFICATION_KINDS) {
      const info = NOTIFICATION_KINDS[kind];
      // RIDDOR's threshold comes from the rate table, never the words "seven days".
      expect(notificationKindLabel(kind, t, 7), kind).toBe(info.label.replace("seven", "7"));
      expect(t("safety.notification.recipient", { kind }).toLowerCase(), kind).toContain(
        info.recipient.toLowerCase().replace(/^the /, ""),
      );
    }
    expect(notificationKindLabel("riddor_over_7_day", t)).toBe(
      "RIDDOR: worker unable to work for longer than the reporting threshold",
    );
    expect(notificationKindLabel("cqc_reg99", t)).toBe(
      "Notification of a kind Harbour does not recognise",
    );
  });

  it("hazard HZ-001 says who each notification about one person is about, and numbers those not shown", () => {
    const names = new Map([[PERSON, "Cara Placeholder"]]);
    const subjects = notificationSubjects(
      [
        draft({ id: "a", kind: "cqc_reg16_death", personId: PERSON }),
        draft({ id: "b", kind: "leder", personId: "0194d000-0000-7000-8600-000000000005" }),
        draft({
          id: "c",
          kind: "medical_examiner",
          personId: "0194d000-0000-7000-8600-000000000006",
        }),
        draft({ id: "d", kind: "leder", personId: "0194d000-0000-7000-8600-000000000005" }),
        draft({ id: "e" }),
      ],
      names,
      t,
    );
    expect(Object.fromEntries(subjects)).toEqual({
      a: "About Cara Placeholder",
      b: "About a person we support (not shown to you), person 1",
      c: "About a person we support (not shown to you), person 2",
      d: "About a person we support (not shown to you), person 1",
    });
  });

  type View = Pick<
    ClassifierView,
    "nationSupported" | "openQuestions" | "pending" | "notifications" | "outputs" | "tasks"
  >;
  const view = (over: Partial<View> = {}): View => ({
    nationSupported: true,
    openQuestions: [],
    pending: [],
    notifications: [],
    outputs: [],
    tasks: [],
    ...over,
  });
  const question = { key: "police.involved" } as View["openQuestions"][number];
  const task = (name: string): View["tasks"][number] => ({
    task: name,
    reason: "",
    dueAt: "2026-10-20T13:05:00Z",
    until: null,
  });
  const manager = { canSubmit: false, canManage: true, closed: false, now: NOW };

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
    [
      "a RIDDOR absence check",
      view({ tasks: [task("riddor_absence_check")] }),
      [],
      [
        "RIDDOR may be needed: check on 20/10/2026 14:05 whether the worker is still unable to do their normal work",
      ],
      null,
    ],
    [
      "the safeguarding decision guide",
      view({ tasks: [task("safeguarding_decision_guide")] }),
      [],
      [
        "A safeguarding concern may be needed: complete the adult safeguarding decision guide by 20/10/2026 14:05",
      ],
      null,
    ],
    [
      "an outbreak report drafted on its first incident",
      view({ outputs: [output({ kind: "ukhsa_outbreak" })] }),
      [],
      ["Needed, and drafted on another record: Outbreak report to the health protection team"],
      null,
    ],
    ["drafts made", view({ notifications: [draft() as never] }), [], [], null],
    [
      "a care task only (the post-fall checklist)",
      view({ tasks: [task("post_fall_observations")] }),
      [],
      [],
      "Harbour found no statutory notification to make on what is recorded so far",
    ],
    [
      "nothing open or drafted",
      view(),
      [],
      [],
      "Harbour found no statutory notification to make on what is recorded so far",
    ],
  ])(
    "hazard HZ-013 never says none are needed while anything is open or waiting: %s",
    (_, classifier, notices, waiting, none) => {
      const result = notificationsView(classifier, manager, t);
      expect(result.notices.map((n) => n.title)).toEqual(notices);
      expect(result.notices.every((n) => n.body.length > 0)).toBe(true);
      expect(result.waiting.map((line) => line.text)).toEqual(waiting);
      expect(result.none).toBe(none);
    },
  );

  it("hazard HZ-013 words the hints for who can act: submitters check, managers answer, others tell", () => {
    const hint = (classifier: View | null, access: { canSubmit: boolean; canManage: boolean }) =>
      notificationsView(classifier, { ...access, closed: false, now: NOW }, t).notices.map(
        (n) => n.body,
      );
    expect(hint(null, { canSubmit: false, canManage: true })).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Until it has, check what the law needs for this incident yourself, and tell the Registered Manager, who submits notifications.",
    ]);
    expect(hint(null, { canSubmit: false, canManage: false })).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Tell the nurse in charge or the Registered Manager.",
    ]);
    expect(hint(null, { canSubmit: true, canManage: true })).toEqual([
      "Harbour has not yet checked which notifications this incident needs. Until it has, check what the law needs for this incident yourself.",
    ]);
    const open = view({ openQuestions: [question] });
    expect(hint(open, { canSubmit: true, canManage: false })).toEqual([
      "The questions are not shown to you here. Tell the nurse in charge or the Registered Manager that this incident has questions to answer.",
    ]);
    expect(hint(open, { canSubmit: false, canManage: true })).toEqual([
      "The questions are not shown to you here. Until they are answered, check what the law needs for this incident yourself.",
    ]);
  });

  it("hazard HZ-013 says a check whose date has passed may not have been done, and drops the checks once closed", () => {
    const checks = view({
      tasks: [
        { ...task("safeguarding_decision_guide"), dueAt: "2026-10-11T13:05:00Z" },
        { ...task("riddor_absence_check"), dueAt: "2026-10-20T13:05:00Z" },
      ],
    });
    expect(notificationsView(checks, manager, t).waiting).toEqual([
      {
        text: "Check whether this was done: the adult safeguarding decision guide, due 11/10/2026 14:05 (a safeguarding concern may be needed)",
        dateTime: "2026-10-11T13:05:00Z",
      },
      {
        text: "RIDDOR may be needed: check on 20/10/2026 14:05 whether the worker is still unable to do their normal work",
        dateTime: "2026-10-20T13:05:00Z",
      },
    ]);
    // Closed: the checks are over, and the stored tasks never clear, so they are left out.
    const closed = notificationsView(checks, { ...manager, closed: true }, t);
    expect(closed.waiting).toEqual([]);
    expect(closed.none).toBe(
      "Harbour found no statutory notification to make on what is recorded so far",
    );
  });

  it("hazard HZ-013 counts overdue notifications and unknown clocks for the chip at the top of the page", () => {
    const notifications = [
      draft(),
      draft({ clock: "due" }),
      draft({ clock: "overdue", id: "n2" }),
      draft({ clock: "paused" as never, id: "n3" }),
      draft({ clock: "done", status: "submitted", id: "n4" }),
    ] as never;
    expect(overdueCount(view({ notifications }))).toBe(3);
    expect(overdueCount(null)).toBe(0);
    expect(t("safety.incident.overdueLink", { count: 2 })).toBe(
      "2 statutory notifications overdue: go to them",
    );
  });
});

describe("hazard HZ-027 the checks after a fall on the incident page", () => {
  it.each([
    // The classifier's task list is empty outside England, but the API raises the post-fall
    // tasks in every nation, so the card never depends on it.
    { type: "fall", restricted: false, shown: true },
    // Closing neither waits for nor cancels the post-fall tasks, so the card stays.
    { type: "fall", restricted: false, shown: true, status: "closed" },
    // A reader who sees the incident only in part is not told it was a fall.
    { type: "fall", restricted: true, shown: false },
    { type: "medication_error", restricted: false, shown: false },
  ])(
    "hazard HZ-027 shows the card for $type (restricted $restricted, status $status): $shown",
    (c) => {
      expect(showsPostFallCard(c)).toBe(c.shown);
    },
  );

  it("hazard HZ-027 points to the task list and never predicts the tasks", () => {
    expect(t("safety.incident.postFall.intro")).toContain(
      "The tasks stay open after this incident is closed until they are done.",
    );
    expect(t("safety.incident.postFall.urgentAdvice")).toMatch(/^Get urgent medical advice now if/);
    expect(t("safety.incident.postFall.link")).toBe(
      "Open the task list to see which checks are due and done",
    );
  });

  it("hazard HZ-027 the body map's saved message never says tasks were raised", () => {
    expect(t("care.bodyMap.savedFollowUp")).toBe(
      "Mark saved. Any follow-up tasks will appear on the task list.",
    );
  });
});

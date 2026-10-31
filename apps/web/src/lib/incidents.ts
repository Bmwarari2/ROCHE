import type {
  ClassifierView,
  IncidentPersonItem,
  IncidentSummary,
  StatutoryNotificationSummary,
} from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";

/**
 * View logic for the incident screens (docs/specs/safety.md; register rows SAFE-001 and
 * SAFE-002; hazard HZ-013). Pure and unit tested. Every status is the API's; the web says it in
 * the catalogue's words with an icon, and a value it does not know warns, never reads as calm.
 */

export type SafetyIcon =
  | "circle-alert"
  | "clock"
  | "circle-check"
  | "circle-minus"
  | "search"
  | "triangle-alert"
  | "file-pen"
  | "send";

export interface SafetyChip {
  readonly status: "overdue" | "due" | "done" | "notApplicable" | "info" | "neutral";
  readonly icon: SafetyIcon;
  readonly label: string;
}

const STATUS_CHIPS: Record<IncidentSummary["status"], Omit<SafetyChip, "label">> = {
  open: { status: "due", icon: "clock" },
  under_review: { status: "info", icon: "search" },
  closed: { status: "done", icon: "circle-check" },
};

/** Where an incident stands: open, under review or closed; one the web does not know warns. */
export function incidentStatusChip(status: string, t: Translator): SafetyChip {
  const known = STATUS_CHIPS[status as IncidentSummary["status"]];
  return {
    ...(known ?? { status: "overdue", icon: "circle-alert" }),
    label: t("safety.incident.status", { status }),
  };
}

/** "Fall, 12/10/2026 14:05": the incident's heading and link, unique with its time. */
export function incidentTitle(
  item: Pick<IncidentSummary, "type" | "occurredAt">,
  t: Translator,
): string {
  return t("safety.incident.title", {
    type: t("safety.incident.type", { type: item.type }),
    dateTime: formatDateTime(item.occurredAt) ?? t("common.notRecorded"),
  });
}

/** The API's limit on one list of incidents (`GET /v1/incidents`). */
export const INCIDENT_LIST_LIMIT = 500;

/**
 * The newest incidents with every open or under-review one fetched besides, newest first, so an
 * older incident still waiting for answers is never hidden by the list's limit (HZ-013).
 * `truncated` says what may be missing: older incidents ("older") when the newest hit the limit,
 * or open and under-review ones too ("unfinished") when one of those lists hit it as well.
 */
export function incidentsToList<I extends Pick<IncidentSummary, "id" | "occurredAt">>(
  newest: readonly I[],
  ...unfinished: readonly (readonly I[])[]
): { readonly items: I[]; readonly truncated: "older" | "unfinished" | null } {
  const byId = new Map<string, I>();
  for (const item of [newest, ...unfinished].flat()) byId.set(item.id, item);
  const full = (list: readonly I[]) => list.length >= INCIDENT_LIST_LIMIT;
  return {
    items: [...byId.values()].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)),
    truncated: unfinished.some(full) ? "unfinished" : full(newest) ? "older" : null,
  };
}

export interface SafetyNotice {
  readonly title: string;
  readonly body: string;
}

/** The sidebar's Incidents label, only for holders of `safety.incident.read`. */
export function incidentsNavLabel(permissions: readonly string[], t: Translator) {
  return permissions.includes("safety.incident.read") ? t("shell.nav.incidents") : undefined;
}

/**
 * A statutory notification's clock (safety.md section 4) as an icon and a word: overdue, and for
 * how long (a "without delay" kind is overdue from the moment it happened until it is done); due;
 * or how it ended, submitted, or not required in the not-applicable style. A clock or ending the
 * web does not know warns. `now` is when the page was drawn.
 */
export function notificationClockChip(
  item: Pick<StatutoryNotificationSummary, "clock" | "status" | "dueAt">,
  now: Date,
  t: Translator,
): SafetyChip {
  switch (item.clock) {
    case "overdue": {
      const late = overdueFor(item.dueAt, now);
      return {
        status: "overdue",
        icon: "circle-alert",
        label: t("safety.notification.overdueFor", {
          unit: late?.unit ?? "unknown",
          count: late?.count ?? 0,
        }),
      };
    }
    case "due":
      return {
        status: "due",
        icon: "clock",
        label: t("safety.notification.clock", { clock: "due" }),
      };
    case "done":
      if (item.status === "submitted") {
        return { status: "done", icon: "circle-check", label: statusLabel(item.status, t) };
      }
      if (item.status === "not_required") {
        return {
          status: "notApplicable",
          icon: "circle-minus",
          label: statusLabel(item.status, t),
        };
      }
      return { status: "overdue", icon: "triangle-alert", label: statusLabel(item.status, t) };
    default:
      return {
        status: "overdue",
        icon: "triangle-alert",
        label: t("safety.notification.clock", { clock: "unknown" }),
      };
  }
}

const statusLabel = (status: string, t: Translator) => t("safety.notification.status", { status });

/** How long past due: whole days, else whole hours, else minutes (at least one). */
export function overdueFor(
  dueAt: string,
  now: Date,
): { readonly unit: "days" | "hours" | "minutes"; readonly count: number } | null {
  const late = now.getTime() - Date.parse(dueAt);
  if (Number.isNaN(late)) return null;
  const minutes = Math.max(1, Math.floor(late / 60_000));
  if (minutes >= 24 * 60) return { unit: "days", count: Math.floor(minutes / (24 * 60)) };
  if (minutes >= 60) return { unit: "hours", count: Math.floor(minutes / 60) };
  return { unit: "minutes", count: minutes };
}

/**
 * Where a draft still open stands, as an icon and a word so a screen reader does not run it on
 * into its clock: a draft, or ready to submit. Nothing once it is done; a status the web does not
 * know warns.
 */
export function notificationStatusChip(
  item: Pick<StatutoryNotificationSummary, "clock" | "status">,
  t: Translator,
): SafetyChip | null {
  if (item.clock === "done") return null;
  if (item.status === "draft") {
    return { status: "neutral", icon: "file-pen", label: statusLabel(item.status, t) };
  }
  if (item.status === "ready") {
    return { status: "info", icon: "send", label: statusLabel(item.status, t) };
  }
  return { status: "overdue", icon: "triangle-alert", label: statusLabel(item.status, t) };
}

const CLOCK_ORDER: Record<string, number> = { overdue: 0, due: 1, done: 2 };

/**
 * A clock the web does not know first (a warning), then overdue, then due soonest first, then
 * done: what needs doing comes first.
 */
export function notificationsInOrder<
  N extends Pick<StatutoryNotificationSummary, "clock" | "dueAt">,
>(items: readonly N[]): N[] {
  // A due time that cannot be read sorts first within its clock: a warning, never lost to NaN.
  const due = (n: N) => {
    const time = Date.parse(n.dueAt);
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
  };
  const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
  return [...items].sort(
    (a, b) =>
      (CLOCK_ORDER[a.clock] ?? -1) - (CLOCK_ORDER[b.clock] ?? -1) || compare(due(a), due(b)),
  );
}

type Output = ClassifierView["outputs"][number];
export interface TimeLine {
  readonly text: string;
  /** The moment, for a `<time>` element; null when the time is not known (a warning). */
  readonly dateTime: string | null;
}

/**
 * When a notification still open is due, in the law's terms (#49 review, HZ-013): each deadline
 * the classifier gave for its kind, from the catalogue ("Without delay: the clock started ...",
 * RIDDOR's report and its second deadline, candour's spoken and written steps), else "Due by".
 * Nothing once it is done; a time that cannot be read warns.
 */
export function notificationDueLines(
  item: Pick<StatutoryNotificationSummary, "kind" | "clock" | "dueAt">,
  outputs: readonly Output[],
  t: Translator,
): TimeLine[] {
  if (item.clock === "done") return [];
  const output =
    outputs.find((o) => o.kind === item.kind && Date.parse(o.dueAt) === Date.parse(item.dueAt)) ??
    outputs.find((o) => o.kind === item.kind);
  const deadlines = output?.deadlines.length
    ? output.deadlines
    : [{ key: "due", dueAt: item.dueAt }];
  return deadlines.map((deadline) => deadlineLine(deadline, t));
}

/** One deadline in the law's terms from the catalogue; a time that cannot be read warns. */
export function deadlineLine(
  deadline: { readonly key: string; readonly dueAt: string },
  t: Translator,
): TimeLine {
  const dateTime = formatDateTime(deadline.dueAt);
  return dateTime
    ? {
        text: t("safety.notification.deadline", { deadline: deadline.key, dateTime }),
        dateTime: deadline.dueAt,
      }
    : { text: t("safety.notification.dueUnknown"), dateTime: null };
}

/** Kinds Harbour sets a time for that should still be made as soon as possible. */
const AS_SOON_AS_POSSIBLE: ReadonlySet<string> = new Set([
  "safeguarding_s42",
  "police_missing_person",
]);

/**
 * The warnings on a draft still open, each with its next step (#49 review): waiting for answers
 * (without inviting a "not required" decision), else no longer indicated, else provisional; and
 * a Harbour target, made as soon as possible all the same for a safeguarding concern or a missing
 * person. A submitted or not-required notification carries none: it is finished. The API keeps a
 * draft provisional after the answer changes, so one no longer indicated says only that.
 */
export function notificationWarnings(
  item: Pick<
    StatutoryNotificationSummary,
    "kind" | "status" | "provisional" | "noLongerIndicated" | "statutory"
  >,
  waitingFor: number | null,
  t: Translator,
): string[] {
  if (item.status !== "draft" && item.status !== "ready") return [];
  const state = item.noLongerIndicated
    ? waitingFor !== null
      ? [t("safety.notification.waiting", { count: waitingFor })]
      : [t("safety.notification.noLongerIndicated")]
    : item.provisional
      ? [t("safety.notification.provisional")]
      : [];
  const target = item.statutory
    ? []
    : [
        t("safety.notification.harbourTarget", {
          soon: String(AS_SOON_AS_POSSIBLE.has(item.kind)),
        }),
      ];
  return [...state, ...target];
}

/**
 * The kind of notification in the catalogue's words, never the API's English label. RIDDOR's
 * over-seven-day kind takes its threshold from the rate table (`riddorDays`), never a literal.
 */
export function notificationKindLabel(kind: string, t: Translator, riddorDays?: number): string {
  return t("safety.notification.kind", { kind, days: riddorDays ?? "none" });
}

/**
 * Who each notification about one person is about (death, LeDeR, the medical examiner, the
 * Herbert Protocol, a DoLS outcome; #49 review, HZ-001): their name from the reader's people, or
 * "a person we support (not shown to you)" numbered, so two are never confused.
 */
export function notificationSubjects(
  items: readonly Pick<StatutoryNotificationSummary, "id" | "personId">[],
  names: ReadonlyMap<string, string>,
  t: Translator,
): Map<string, string> {
  const unseen: string[] = [];
  const subjects = new Map<string, string>();
  for (const item of items) {
    if (!item.personId) continue;
    const name = names.get(item.personId);
    if (name) {
      subjects.set(item.id, t("safety.notification.about", { known: "true", name }));
      continue;
    }
    if (!unseen.includes(item.personId)) unseen.push(item.personId);
    const ordinal = unseen.indexOf(item.personId) + 1;
    subjects.set(item.id, t("safety.notification.about", { known: "false", ordinal }));
  }
  return subjects;
}

/**
 * The notifications needing attention now, for the chip at the top of the incident page: overdue,
 * and any whose clock the web does not know (#49 review round 2).
 */
export function overdueCount(classifier: Pick<ClassifierView, "notifications"> | null): number {
  return (classifier?.notifications ?? []).filter((n) => n.clock !== "due" && n.clock !== "done")
    .length;
}

/** Classifier tasks that decide whether a notification is needed, in the catalogue's words. */
const NOTIFICATION_TASKS: ReadonlySet<string> = new Set([
  "riddor_absence_check",
  "safeguarding_decision_guide",
  "outbreak_link_review",
  "candour_threshold_decision",
]);

export interface NotificationsView {
  /** Warnings that come before the list: never read as "nothing to do". */
  readonly notices: readonly SafetyNotice[];
  /**
   * What is waiting before Harbour can say: kinds waiting for answers, checks that decide whether
   * one is needed (with when), and notifications drafted on another record.
   */
  readonly waiting: readonly TimeLine[];
  /** Says none was found, only when nothing is open, waiting or drafted and the law is checked. */
  readonly none: string | null;
}

/**
 * What the notifications section says around its list (safety.md section 5; HZ-013). Not checked
 * yet, outside England and questions still to answer warn; so do kinds waiting for answers,
 * checks that decide whether one is needed (RIDDOR's absence check, the safeguarding decision
 * guide, an outbreak's links, the candour decision) and outputs drafted on another record (an
 * outbreak's first incident). "None found" is said only when none of these is there (#49
 * review). The questions are answered by holders of `safety.incident.manage`; "not checked" is
 * worded for holders of `safety.notification.submit`, who are not sent to ask themselves.
 *
 * The stored tasks carry no done state, and classifying again does not clear these checks (#49
 * review round 2): on a closed incident they are left out, and once a check's date has passed it
 * reads "Check whether this was done: ..." rather than "by" a date gone by.
 */
export function notificationsView(
  classifier: Pick<
    ClassifierView,
    "nationSupported" | "openQuestions" | "pending" | "notifications" | "outputs" | "tasks"
  > | null,
  context: {
    readonly canSubmit: boolean;
    readonly canManage: boolean;
    /** The incident is closed: its checks are over. */
    readonly closed: boolean;
    /** When the page was drawn. */
    readonly now: Date;
    /** How many of the open questions the page offers the reader to answer (default none). */
    readonly answerable?: number;
  },
  t: Translator,
  riddorDays?: number,
): NotificationsView {
  const notice = (notice: string, self: boolean | "answer" | "some" | "manage", count = 0) => ({
    title: t("safety.notification.notice", { notice, count }),
    body: t("safety.notification.noticeHint", { notice, self: String(self) }),
  });
  if (!classifier) {
    // Who checks the law meanwhile: a submitter themselves; someone who manages incidents but cannot
    // submit checks it too and tells the Registered Manager; anyone else tells the person in charge.
    const self = context.canSubmit ? true : context.canManage ? "manage" : false;
    return { notices: [notice("notChecked", self)], waiting: [], none: null };
  }
  if (!classifier.nationSupported) {
    return { notices: [notice("nation", context.canSubmit)], waiting: [], none: null };
  }
  const count = classifier.openQuestions.length;
  const label = (kind: string) => notificationKindLabel(kind, t, riddorDays);
  const pending = classifier.pending.map((p) => ({
    text: t("safety.notification.pending", { kind: label(p.kind) }),
    dateTime: null,
  }));
  const tasks = (context.closed ? [] : classifier.tasks)
    .filter((task) => NOTIFICATION_TASKS.has(task.task))
    .map((task) => {
      const dateTime = formatDateTime(task.dueAt);
      const past = dateTime !== null && Date.parse(task.dueAt ?? "") < context.now.getTime();
      return {
        text: past
          ? t("safety.notification.taskPast", { task: task.task, dateTime })
          : t("safety.notification.task", { task: task.task, dateTime: dateTime ?? "none" }),
        dateTime: dateTime ? task.dueAt : null,
      };
    });
  const drafted = new Set(classifier.notifications.map((n) => n.kind));
  const elsewhere = [...new Set(classifier.outputs.map((o) => o.kind))]
    .filter((kind) => !drafted.has(kind))
    .map((kind) => ({
      text: t("safety.notification.elsewhere", { kind: label(kind) }),
      dateTime: null,
    }));
  const waiting = [...pending, ...tasks, ...elsewhere];
  return {
    notices: count > 0 ? [notice("questions", questionsHint(count, context), count)] : [],
    waiting,
    none:
      count === 0 &&
      waiting.length === 0 &&
      classifier.outputs.length === 0 &&
      classifier.notifications.length === 0
        ? t("safety.notification.none")
        : null,
  };
}

/**
 * Who answers the open questions: the reader, below ("answer"); the reader some of them and the
 * nurse in charge or Registered Manager the rest ("some"); or, with no form, the reader checks the
 * law themselves (a manager) or tells someone who can.
 */
function questionsHint(
  count: number,
  context: { readonly canManage: boolean; readonly answerable?: number },
): boolean | "answer" | "some" {
  const answerable = context.answerable ?? 0;
  if (answerable >= count) return "answer";
  if (answerable > 0) return "some";
  return context.canManage;
}

/** What was recorded about someone on an incident, beyond their name and role. */
export function incidentPersonFacts(
  person: Pick<
    IncidentPersonItem,
    "died" | "learningDisability" | "autistic" | "subjectToMentalHealthAct" | "bodyMapMarkIds"
  >,
  t: Translator,
): string[] {
  const fact = (on: boolean | null, fact: string) =>
    on ? [t("safety.incident.personFact", { fact })] : [];
  return [
    ...fact(person.died, "died"),
    ...fact(person.learningDisability, "learningDisability"),
    ...fact(person.autistic, "autistic"),
    ...fact(person.subjectToMentalHealthAct, "mentalHealthAct"),
    ...(person.bodyMapMarkIds.length > 0
      ? [t("safety.incident.bodyMapMarks", { count: person.bodyMapMarkIds.length })]
      : []),
  ];
}

/**
 * Who someone on an incident is, in words: a person using the service by the name the API gave
 * for them, a member of staff, or the name recorded for someone not at work.
 */
export function incidentPersonLine(
  person: Pick<IncidentPersonItem, "kind" | "role" | "personId" | "otherName">,
  names: ReadonlyMap<string, string>,
  t: Translator,
): string {
  const name =
    (person.personId ? names.get(person.personId) : undefined) ??
    person.otherName ??
    t("safety.incident.unnamed", { kind: person.kind });
  return t("safety.incident.person", { name, role: person.role });
}

/** The post-fall checklist's care tasks (packages/domain/src/safety/post-fall.ts), in its order. */
export const POST_FALL_TASKS = [
  "urgent_medical_advice",
  "post_fall_injury_check",
  "post_fall_observations",
  "post_fall_monitoring",
  "gp_contact",
  "ng249_falls_pathway",
  "bone_health_review",
] as const;

export interface PostFallCheck {
  readonly task: (typeof POST_FALL_TASKS)[number];
  readonly title: string;
  readonly urgent: boolean;
  /** "Due 31/10/2026 14:05", "Until ...", or null when the organisation's defaults set it. */
  readonly when: string | null;
  readonly dateTime: string | null;
}

/**
 * The checks after a fall that the classifier set as care tasks (HZ-027): shown on the incident
 * page so the person reading it sees, in words, that urgent medical advice is needed, rather than
 * finding it only in the task list. Urgent medical advice comes first. Left out once closed.
 */
export function postFallChecks(
  classifier: Pick<ClassifierView, "tasks"> | null,
  closed: boolean,
  t: Translator,
): PostFallCheck[] {
  if (!classifier || closed) return [];
  const order = (task: string) => POST_FALL_TASKS.indexOf(task as (typeof POST_FALL_TASKS)[number]);
  return classifier.tasks
    .filter((task) => order(task.task) >= 0)
    .sort((a, b) => order(a.task) - order(b.task))
    .map((task) => {
      const due = formatDateTime(task.dueAt);
      const until = formatDateTime(task.until);
      return {
        task: task.task as (typeof POST_FALL_TASKS)[number],
        title: t("safety.incident.postFall.task", { task: task.task }),
        urgent: task.task === "urgent_medical_advice",
        when: until
          ? t("safety.incident.postFall.until", { dateTime: until })
          : due
            ? t("safety.incident.postFall.due", { dateTime: due })
            : null,
        dateTime: until ? task.until : due ? task.dueAt : null,
      };
    });
}

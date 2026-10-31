import type { CandourItem, ClassifierView, DocumentItem, IncidentDetail } from "@harbour/contracts";
import {
  availableTransitions,
  CANDOUR_REASON_MIN,
  CANDOUR_WORKFLOW,
  type CandourCloseFacts,
  type CandourRecordView,
  type CandourState,
  candourDecisionNeedsReason,
  candourFindingOf,
  candourStepProblems,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { formatDate, formatDateTime } from "./format";
import type { SafetyChip, TimeLine } from "./incidents";
import type { FieldErrors } from "./outcome";
import { knownRefusals } from "./refusals";
import { formatUkTime, readDateTimeField, ukToday } from "./uk-time";

/**
 * View logic for the duty of candour record on the incident page (safety.md section 4 rule 5;
 * register row SAFE-007; hazards HZ-013 and HZ-091). Pure and unit tested. The steps and what each
 * needs are the domain's own (`CANDOUR_WORKFLOW`, `candourStepProblems`), the rules the API
 * checks, so the page never offers a step the API would refuse; the API checks everything again.
 */

/** The longest text the API takes for each field (`UpdateCandour`). */
export const CANDOUR_LIMITS = {
  decidedBy: 200,
  representative: 200,
  representatives: 10,
  attemptNote: 1000,
  outcome: 2000,
  reason: 1000,
} as const;

type FormValues = Pick<FormData, "get" | "getAll">;
const text = (form: FormValues, name: string) => String(form.get(name) ?? "").trim();

const STATE_CHIPS: Record<CandourState, Omit<SafetyChip, "label">> = {
  threshold_assessment: { status: "due", icon: "clock" },
  verbal_due: { status: "due", icon: "clock" },
  written_due: { status: "due", icon: "clock" },
  enquiries_open: { status: "info", icon: "search" },
  not_notifiable: { status: "notApplicable", icon: "circle-minus" },
  no_contact: { status: "done", icon: "circle-check" },
  closed: { status: "done", icon: "circle-check" },
};

/** Where the candour record stands, as an icon and words; a stage the web does not know warns. */
export function candourStateChip(state: string, t: Translator): SafetyChip {
  const known = STATE_CHIPS[state as CandourState];
  return {
    ...(known ?? { status: "overdue", icon: "triangle-alert" }),
    label: t("safety.candour.state", { state }),
  };
}

/** The API's record as the domain reads it (dates as `Date`), for `candourStepProblems`. */
export function toCandourRecordView(item: CandourItem): CandourRecordView {
  return {
    threshold: item.threshold
      ? {
          notifiable: item.threshold.notifiable,
          decidedAt: new Date(item.threshold.decidedAt),
          decidedBy: item.threshold.decidedBy,
        }
      : null,
    verbal: item.verbal ? { ...item.verbal, at: new Date(item.verbal.at) } : null,
    contactAttempts: item.contactAttempts.map((a) => ({ at: new Date(a.at), note: a.note })),
    written: item.written ? { ...item.written, sentAt: new Date(item.written.sentAt) } : null,
    enquiryResultsSharedAt: item.enquiryResultsSharedAt
      ? new Date(item.enquiryResultsSharedAt)
      : null,
    correspondenceDocumentIds: item.correspondenceDocumentIds,
  };
}

/**
 * What a step still needs, in the catalogue's words: the domain's `candourStepProblems`, which
 * the API runs before it takes the step, each recognised as the API's refusal would be
 * (`knownRefusals`). One the web does not recognise is shown as the domain says it.
 */
export function candourStepNeeds(to: CandourState, item: CandourItem, t: Translator): string[] {
  return candourStepProblems(to, toCandourRecordView(item)).map((problem) => {
    const known = knownRefusals(problem)[0];
    return known ? t(`care.refusal.${known.key}`) : problem;
  });
}

export interface CandourStepOffer {
  readonly to: CandourState;
  /** The workflow asks for a reason (not notifiable, no contact, closed). */
  readonly needsReason: boolean;
  /**
   * "Not notifiable" after Harbour drafted a candour notification: the reason must be a sentence
   * (`DISAGREE_REASON_MIN`) and the decision confirmed (review M4, as H-265 for notifications).
   */
  readonly strict: boolean;
  /** What must be recorded first; the step is offered only when this is empty. */
  readonly needs: readonly string[];
}

/**
 * The steps the viewer may take from where the record stands (`availableTransitions`), each with
 * what it still needs. From the threshold assessment only the step the decision points to is
 * offered, once it is recorded: the threshold form comes first.
 */
export function candourSteps(
  item: CandourItem | null,
  viewer: { readonly tenantUserId: string; readonly permissions: readonly string[] },
  t: Translator,
  /** Harbour drafted a candour notification on the incident (from its answers or a decision). */
  drafted = false,
): CandourStepOffer[] {
  if (!item) return [];
  const state = item.state as CandourState;
  if (!CANDOUR_WORKFLOW.states.includes(state)) return [];
  if (state === "threshold_assessment" && !item.threshold) return [];
  const moves = availableTransitions(
    CANDOUR_WORKFLOW,
    { state, createdBy: "" },
    viewer.tenantUserId,
    new Set(viewer.permissions),
  );
  return moves
    .filter(
      (to) =>
        state !== "threshold_assessment" ||
        (to === "verbal_due") === Boolean(item.threshold?.notifiable),
    )
    .map((to) => {
      const rule = CANDOUR_WORKFLOW.transitions.find((r) => r.to === to);
      return {
        to,
        needsReason: Boolean(rule?.requiresReason) || (drafted && to === "not_notifiable"),
        strict: drafted && to === "not_notifiable",
        needs: candourStepNeeds(to, item, t),
      };
    });
}

/**
 * The forms the record takes at each stage. A record finished as not notifiable or no contact
 * offers only reopening it with a reason (#120 review round 3, H1); one closed, nothing.
 */
export type CandourForm = "threshold" | "verbal" | "attempt" | "written" | "followUp" | "reopen";

export function candourForms(state: string | null): CandourForm[] {
  switch (state) {
    case null:
    case "threshold_assessment":
      return ["threshold"];
    case "verbal_due":
      return ["verbal", "attempt"];
    case "written_due":
    case "enquiries_open":
      return ["written", "followUp"];
    case "not_notifiable":
    case "no_contact":
      return ["reopen"];
    default:
      return [];
  }
}

/**
 * Whether the viewer is offered the candour forms: a holder of `safety.incident.manage`, on an
 * incident seen whole and not closed (the API refuses a restricted reader; a closed incident is
 * read here as it is). Where the permission reaches is the API's to check (ADR-0071).
 */
export function candourManageable(
  incident: Pick<IncidentDetail, "status" | "restricted">,
  permissions: readonly string[],
): boolean {
  return (
    permissions.includes("safety.incident.manage") &&
    !incident.restricted &&
    incident.status !== "closed"
  );
}

/**
 * What the classifier says about the duty of candour, for an incident with no candour record
 * yet: found (a draft or an output), waiting for answers or for the threshold decision, or not
 * found on what is recorded so far.
 */
export function candourFinding(
  classifier: Pick<ClassifierView, "outputs" | "notifications" | "pending" | "tasks"> | null,
): "found" | "waiting" | "none" {
  if (!classifier) return "none";
  const kinds = [...classifier.outputs, ...classifier.notifications].map((o) => o.kind);
  if (kinds.includes("candour")) return "found";
  if (
    classifier.pending.some((p) => p.kind === "candour") ||
    classifier.tasks.some((task) => task.task === "candour_threshold_decision")
  ) {
    return "waiting";
  }
  return "none";
}

/**
 * What closing needs to know about the duty of candour, read from the incident as the API reads it
 * (`incidentCloseProblems`; review H1 and H2): whether Harbour found it may apply, the record's
 * decision and relevant person, and the people we support affected by the incident.
 */
export function candourCloseFacts(
  incident: Pick<IncidentDetail, "people" | "classifier">,
  record: Pick<CandourItem, "threshold" | "personId"> | null,
): CandourCloseFacts {
  const classifier = incident.classifier;
  return {
    indicated:
      (classifier?.outputs ?? []).some((o) => o.kind === "candour") ||
      (classifier?.notifications ?? []).some(
        (n) => n.kind === "candour" && n.status !== "not_required" && !n.noLongerIndicated,
      ),
    notifiable: record?.threshold?.notifiable ?? null,
    personId: record?.personId ?? null,
    people: [
      ...new Set(
        incident.people.flatMap((p) =>
          p.kind === "service_user" && p.role === "affected" && p.personId ? [p.personId] : [],
        ),
      ),
    ],
  };
}

/**
 * What Harbour found on the answers recorded, to set beside the threshold question (review M4):
 * that it may be notifiable (a candour draft or output), that it is not (the classifier excluded
 * it), or that it is waiting for answers. Null once a decision is recorded, because the classifier
 * then follows the decision.
 */
export type HarbourFinding = "notifiable" | "notNotifiable" | "waiting";

export function harbourFinding(
  classifier: Pick<
    ClassifierView,
    "outputs" | "notifications" | "pending" | "tasks" | "exclusions"
  > | null,
  record: Pick<CandourItem, "threshold"> | null,
): HarbourFinding | null {
  // The domain's reading, as the API reads it before a decision (#120 round 2, M3).
  return record?.threshold ? null : candourFindingOf(classifier);
}

/** The shortest reason for a decision that differs from Harbour's finding, or changes one. */
export const DISAGREE_REASON_MIN = CANDOUR_REASON_MIN;

/**
 * Whether a threshold answer needs a confirmation and a reason (review M4): it changes a decision
 * already recorded, or differs from what Harbour found on the answers.
 */
export function thresholdDisagrees(
  notifiable: boolean,
  finding: HarbourFinding | null,
  current: CandourItem["threshold"],
): boolean {
  return candourDecisionNeedsReason(notifiable, finding, current?.notifiable ?? null);
}

/** Whether the incident page shows the candour section: there is a record, or someone it could be about. */
export function candourShown(
  incident: Pick<IncidentDetail, "restricted" | "people">,
  record: CandourItem | null,
): boolean {
  if (incident.restricted) return false;
  return record !== null || incident.people.some((p) => p.kind === "service_user");
}

export interface CandourClock {
  readonly chip: SafetyChip;
  readonly line: TimeLine;
}

/**
 * The candour clocks in words and icons (ADR-0021): telling the person is due "as soon as
 * reasonably practicable" from when the clock started, and the written notification has the
 * organisation's target, never called a legal deadline. The number of working days comes from
 * the rate table (`writtenDays`), never a literal. Nothing once it is not notifiable; until the
 * threshold decision the clocks run from when the incident happened (`provisional`).
 */
export function candourClocks(
  item: CandourItem,
  now: Date,
  t: Translator,
  writtenDays?: number,
): { readonly clocks: readonly CandourClock[]; readonly provisional: boolean } | null {
  if (item.state === "not_notifiable" || item.threshold?.notifiable === false) return null;
  const clocks: CandourClock[] = [];
  const at = (iso: string) => formatDateTime(iso);
  if (item.verbal?.inPerson) {
    clocks.push({
      chip: {
        status: "done",
        icon: "circle-check",
        label: t("safety.candour.clock", { clock: "told" }),
      },
      line: line(
        t("safety.candour.toldAt", { dateTime: at(item.verbal.at) ?? "" }),
        item.verbal.at,
        t,
      ),
    });
  } else if (item.verbal && item.state !== "no_contact") {
    // Recorded, but not in person: regulation 20(3)(a) is not met, so it is still due (review M2).
    clocks.push({
      chip: { status: "due", icon: "clock", label: t("safety.candour.clock", { clock: "due" }) },
      line: line(
        t("safety.candour.notInPerson", { dateTime: at(item.verbal.at) ?? "" }),
        item.verbal.at,
        t,
      ),
    });
  } else if (item.state === "no_contact") {
    clocks.push({
      chip: {
        status: "notApplicable",
        icon: "circle-minus",
        label: t("safety.candour.clock", { clock: "noContact" }),
      },
      line: { text: t("safety.candour.noContactLine"), dateTime: null },
    });
  } else {
    const started = item.clocks.verbalDueAt;
    clocks.push({
      chip: { status: "due", icon: "clock", label: t("safety.candour.clock", { clock: "due" }) },
      line: line(
        t("safety.notification.deadline", {
          deadline: "verbal_notification",
          dateTime: at(started) ?? "",
        }),
        started,
        t,
      ),
    });
  }
  if (item.written) {
    clocks.push({
      chip: {
        status: "done",
        icon: "circle-check",
        label: t("safety.candour.clock", { clock: "sent" }),
      },
      line: line(
        t("safety.candour.sentAt", { dateTime: at(item.written.sentAt) ?? "" }),
        item.written.sentAt,
        t,
      ),
    });
  } else if (item.state !== "no_contact") {
    const target = item.clocks.writtenTargetAt;
    const past = Date.parse(target) < now.getTime();
    clocks.push({
      chip: past
        ? {
            status: "overdue",
            icon: "circle-alert",
            label: t("safety.candour.clock", { clock: "pastTarget" }),
          }
        : { status: "due", icon: "clock", label: t("safety.candour.clock", { clock: "target" }) },
      line: line(
        t("safety.candour.writtenTarget", {
          days: writtenDays ?? "none",
          when: byWhen(target, t),
        }),
        target,
        t,
      ),
    });
  }
  return { clocks, provisional: item.clocks.provisional };
}

/**
 * When a target falls due, in words: a target at midnight UK time is the end of the day before
 * ("by the end of 13/11/2026"), never "by 14/11/2026 00:00" (review L2); any other time is
 * "by" that date and time.
 */
export function byWhen(iso: string, t: Translator): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return t("safety.notification.dueUnknown");
  if (formatUkTime(iso) === "00:00") {
    return t("safety.candour.byWhen", {
      end: "true",
      date: formatDate(ukToday(new Date(at - 1))) ?? "",
    });
  }
  return t("safety.candour.byWhen", { end: "false", date: formatDateTime(iso) ?? "" });
}

/** A moment in words; one that cannot be read warns. */
function line(text: string, iso: string, t: Translator): TimeLine {
  return formatDateTime(iso)
    ? { text, dateTime: iso }
    : { text: t("safety.notification.dueUnknown"), dateTime: null };
}

/** A document the candour record can keep: a PDF on the relevant person's record, available. */
export interface CandourDocument {
  readonly id: string;
  readonly label: string;
}

/**
 * The documents a candour form offers, newest first: the relevant person's available PDFs
 * (letters sent and documents added), each named by its title and when it was added. Documents
 * the web cannot open (images, quarantined ones) are left out.
 */
export function candourDocuments(
  documents: readonly Pick<DocumentItem, "id" | "title" | "createdAt" | "status" | "contentType">[],
  t: Translator,
): CandourDocument[] {
  return documents
    .filter((d) => d.status === "available" && d.contentType === "application/pdf")
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((d) => ({
      id: d.id,
      label: t("safety.candour.document", {
        title: d.title,
        dateTime: formatDateTime(d.createdAt) ?? t("common.notRecorded"),
      }),
    }));
}

// ------------------------------------------------------------------------------------------------
// Reading the forms. "Just now" is null: the server action takes its own time (HZ-090).
// ------------------------------------------------------------------------------------------------

type Read<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts?: Readonly<Record<string, readonly string[]>>;
    };

interface Errors {
  readonly errors: Record<string, string>;
  readonly parts: Record<string, readonly string[]>;
}

const newErrors = (): Errors => ({ errors: {}, parts: {} });

function failed<T>(found: Errors): Read<T> | null {
  if (Object.keys(found.errors).length === 0) return null;
  return {
    ok: false,
    errors: found.errors,
    ...(Object.keys(found.parts).length > 0 ? { parts: found.parts } : {}),
  };
}

/**
 * A "when" chosen every time (as already recorded, just now, or earlier with the date and time),
 * never in the future: null for just now, the recorded time to keep it, undefined when it cannot
 * be read (the error is in `found`).
 */
function readMoment(
  form: FormValues,
  name: string,
  subject: string,
  now: Date,
  t: Translator,
  found: Errors,
  recorded: string | null = null,
): string | null | undefined {
  const mode = text(form, `${name}-mode`);
  if (mode === "keep" && recorded) return recorded;
  if (mode === "now") return null;
  if (mode !== "earlier") {
    found.errors[name] = t("safety.candour.error", { field: "when" });
    return undefined;
  }
  const read = readDateTimeField(form, name, { subject, t, now, futureToleranceMinutes: 0 });
  if (read.ok && read.instant) return read.instant;
  if (!read.ok) {
    found.errors[name] = read.message;
    found.parts[name] = read.parts;
  } else {
    found.errors[name] = t("safety.candour.error", { field: "when" });
  }
  return undefined;
}

/** A yes or no question with nothing chosen until someone chooses (HZ-090). */
function readYesNo(
  form: FormValues,
  name: string,
  error: string,
  found: Errors,
): boolean | undefined {
  const value = text(form, name);
  if (value === "yes") return true;
  if (value === "no") return false;
  found.errors[name] = error;
  return undefined;
}

/** A document chosen from the offered list, or none. */
function readDocument(
  form: FormValues,
  name: string,
  offered: readonly CandourDocument[],
  current: string | null,
): string | null {
  const value = text(form, name);
  if (!value) return null;
  return offered.some((d) => d.id === value) || value === current ? value : null;
}

export interface ThresholdInput {
  readonly personId: string | null;
  readonly notifiable: boolean;
  /** Null for just now. */
  readonly decidedAt: string | null;
  readonly decidedBy: string;
  /**
   * Why, when the decision differs from Harbour's finding or changes one (review M4): the record
   * then moves on with it as the step's reason, kept with the record. Null otherwise.
   */
  readonly reason: string | null;
}

/**
 * The threshold decision: who it happened to (one of the people we support on the incident), yes
 * or no with nothing assumed, when (never in the future: the API refuses it) and the health care
 * professional whose opinion it records.
 */
export function readThresholdForm(
  form: FormValues,
  people: readonly string[],
  current: CandourItem["threshold"],
  now: Date,
  t: Translator,
  finding: HarbourFinding | null = null,
): Read<{ readonly input: ThresholdInput }> {
  const found = newErrors();
  let personId: string | null = null;
  if (people.length > 0) {
    const chosen = text(form, "personId");
    if (people.includes(chosen)) personId = chosen;
    else found.errors.personId = t("safety.candour.error", { field: "personId" });
  }
  const notifiable = readYesNo(
    form,
    "notifiable",
    t("safety.candour.error", { field: "notifiable" }),
    found,
  );
  const decidedAt = readMoment(
    form,
    "decidedAt",
    t("safety.candour.subject", { field: "decidedAt" }),
    now,
    t,
    found,
    current?.decidedAt ?? null,
  );
  const decidedBy = text(form, "decidedBy");
  if (decidedBy.length < 2 || decidedBy.length > CANDOUR_LIMITS.decidedBy) {
    found.errors.decidedBy = t("safety.candour.error", { field: "decidedBy" });
  }
  const disagrees = notifiable !== undefined && thresholdDisagrees(notifiable, finding, current);
  const reason = text(form, "reason");
  if (disagrees) {
    if (reason.length < DISAGREE_REASON_MIN || reason.length > CANDOUR_LIMITS.reason) {
      found.errors.reason = t("safety.candour.error", { field: "reason" });
    }
    if (text(form, "confirm") !== "yes") {
      found.errors.confirm = t("safety.candour.error", { field: "confirm" });
    }
  }
  const failure = failed<{ input: ThresholdInput }>(found);
  if (failure || notifiable === undefined || decidedAt === undefined) {
    return failure ?? { ok: false, errors: found.errors };
  }
  return {
    ok: true,
    input: {
      personId,
      notifiable,
      decidedAt,
      decidedBy,
      reason: disagrees ? reason : null,
    },
  };
}

export interface VerbalInput {
  /** Null for just now. */
  readonly at: string | null;
  readonly byRepresentatives: readonly string[];
  readonly inPerson: boolean;
  readonly accountGiven: boolean;
  readonly enquiriesAdvised: boolean;
  readonly apologyGiven: boolean;
  readonly writtenRecordId: string | null;
}

/** One name and role per line, blank lines dropped; at most 10 of at most 200 characters. */
export function readRepresentatives(value: string): string[] | null {
  const lines = value
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > CANDOUR_LIMITS.representatives) return null;
  if (lines.some((l) => l.length > CANDOUR_LIMITS.representative)) return null;
  return lines;
}

/**
 * Telling the person (regulation 20(3)): when, who told them, whether in person (asked, never
 * assumed), what they were told and the written record of it. What is missing for the next step
 * is said beside the step, not refused here: the record can be saved as it stands.
 */
export function readVerbalForm(
  form: FormValues,
  offered: readonly CandourDocument[],
  current: CandourItem["verbal"],
  now: Date,
  t: Translator,
): Read<{ readonly input: VerbalInput }> {
  const found = newErrors();
  const at = readMoment(
    form,
    "at",
    t("safety.candour.subject", { field: "toldAt" }),
    now,
    t,
    found,
    current?.at ?? null,
  );
  const byRepresentatives = readRepresentatives(text(form, "byRepresentatives"));
  if (!byRepresentatives) {
    found.errors.byRepresentatives = t("safety.candour.error", { field: "byRepresentatives" });
  }
  const inPerson = readYesNo(
    form,
    "inPerson",
    t("safety.candour.error", { field: "inPerson" }),
    found,
  );
  const failure = failed<{ input: VerbalInput }>(found);
  if (failure || at === undefined || !byRepresentatives || inPerson === undefined) {
    return failure ?? { ok: false, errors: found.errors };
  }
  return {
    ok: true,
    input: {
      at,
      byRepresentatives,
      inPerson,
      accountGiven: text(form, "accountGiven") === "yes",
      enquiriesAdvised: text(form, "enquiriesAdvised") === "yes",
      apologyGiven: text(form, "apologyGiven") === "yes",
      writtenRecordId: readDocument(
        form,
        "writtenRecordId",
        offered,
        current?.writtenRecordId ?? null,
      ),
    },
  };
}

export interface AttemptInput {
  /** Null for just now. */
  readonly at: string | null;
  readonly note: string;
}

/** One attempt to contact the person (regulation 20(5)(b)): when, and what happened. */
export function readAttemptForm(
  form: FormValues,
  now: Date,
  t: Translator,
): Read<{ readonly input: AttemptInput }> {
  const found = newErrors();
  const at = readMoment(
    form,
    "attemptAt",
    t("safety.candour.subject", { field: "attemptAt" }),
    now,
    t,
    found,
  );
  const note = text(form, "note");
  if (note.length < 3 || note.length > CANDOUR_LIMITS.attemptNote) {
    found.errors.note = t("safety.candour.error", { field: "note" });
  }
  const failure = failed<{ input: AttemptInput }>(found);
  if (failure || at === undefined) return failure ?? { ok: false, errors: found.errors };
  return { ok: true, input: { at, note } };
}

export interface WrittenInput {
  /** Null for just now. */
  readonly sentAt: string | null;
  readonly documentId: string | null;
  readonly includesAccount: boolean;
  readonly includesEnquiries: boolean;
  readonly includesApology: boolean;
}

/** The written notification (regulation 20(4)): when it was sent, what it included, its copy. */
export function readWrittenForm(
  form: FormValues,
  offered: readonly CandourDocument[],
  current: CandourItem["written"],
  now: Date,
  t: Translator,
): Read<{ readonly input: WrittenInput }> {
  const found = newErrors();
  const sentAt = readMoment(
    form,
    "sentAt",
    t("safety.candour.subject", { field: "sentAt" }),
    now,
    t,
    found,
    current?.sentAt ?? null,
  );
  const failure = failed<{ input: WrittenInput }>(found);
  if (failure || sentAt === undefined) return failure ?? { ok: false, errors: found.errors };
  return {
    ok: true,
    input: {
      sentAt,
      documentId: readDocument(form, "documentId", offered, current?.documentId ?? null),
      includesAccount: text(form, "includesAccount") === "yes",
      includesEnquiries: text(form, "includesEnquiries") === "yes",
      includesApology: text(form, "includesApology") === "yes",
    },
  };
}

export interface FollowUpInput {
  /** When the results were shared, or null for not yet. */
  readonly enquiryResultsSharedAt: string | null;
  readonly correspondenceDocumentIds: readonly string[];
  readonly outcome: string | null;
}

/**
 * The results of the enquiries and the correspondence (regulation 20(4)(c) and (6)): when the
 * results were shared (left empty until they are; never in the future), each document kept as
 * correspondence, and the outcome in words.
 */
export function readFollowUpForm(
  form: FormValues,
  offered: readonly CandourDocument[],
  current: readonly string[],
  now: Date,
  t: Translator,
): Read<{ readonly input: FollowUpInput }> {
  const found = newErrors();
  const shared = readDateTimeField(form, "resultsSharedAt", {
    subject: t("safety.candour.subject", { field: "resultsSharedAt" }),
    t,
    now,
    optional: true,
    futureToleranceMinutes: 0,
  });
  if (!shared.ok) {
    found.errors.resultsSharedAt = shared.message;
    found.parts.resultsSharedAt = shared.parts;
  }
  const outcome = text(form, "outcome");
  if (outcome.length > CANDOUR_LIMITS.outcome) {
    found.errors.outcome = t("safety.candour.error", { field: "outcome" });
  }
  const failure = failed<{ input: FollowUpInput }>(found);
  if (failure || !shared.ok) return failure ?? { ok: false, errors: found.errors };
  const allowed = new Set([...offered.map((d) => d.id), ...current]);
  const ids = form
    .getAll("correspondence")
    .map((v) => String(v))
    .filter((id) => allowed.has(id));
  return {
    ok: true,
    input: {
      enquiryResultsSharedAt: shared.instant,
      correspondenceDocumentIds: [...new Set(ids)],
      outcome: outcome || null,
    },
  };
}

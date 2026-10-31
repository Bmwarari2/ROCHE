import type { CandourItem, ClassifierView, DocumentItem, IncidentDetail } from "@harbour/contracts";
import {
  availableTransitions,
  CANDOUR_WORKFLOW,
  type CandourRecordView,
  type CandourState,
  candourStepProblems,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import { formatDateTime } from "./format";
import type { SafetyChip, TimeLine } from "./incidents";
import type { FieldErrors } from "./outcome";
import { knownRefusals } from "./refusals";
import { readDateTimeField } from "./uk-time";

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
        needsReason: Boolean(rule?.requiresReason),
        needs: candourStepNeeds(to, item, t),
      };
    });
}

/** The forms the record takes at each stage: nothing once it is finished. */
export type CandourForm = "threshold" | "verbal" | "attempt" | "written" | "followUp";

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
  if (item.verbal) {
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
          dateTime: at(target) ?? "",
        }),
        target,
        t,
      ),
    });
  }
  return { clocks, provisional: item.clocks.provisional };
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
  const failure = failed<{ input: ThresholdInput }>(found);
  if (failure || notifiable === undefined || decidedAt === undefined) {
    return failure ?? { ok: false, errors: found.errors };
  }
  return { ok: true, input: { personId, notifiable, decidedAt, decidedBy } };
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

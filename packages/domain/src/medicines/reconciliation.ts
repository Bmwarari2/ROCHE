/**
 * Medicines reconciliation (medicines.md rules 7 to 12; HZ-121, HZ-005). When a person is
 * admitted, transferred or returns from hospital, or their medicines change, a competent member
 * of staff compares the MAR with the sources (the discharge letter, the GP record, the previous
 * MAR, the medicines that came with the person, what the person and family say) and decides, for
 * every medicine on the MAR and every medicine in the sources, what happens to it.
 *
 * Each source line is recorded as written, with its dm+d product and what it says about the
 * medicine: start, continue, change, stop or unclear. A decision is supported only by a line that
 * says that thing about the same dm+d product (by identity, never ingredient), from a document
 * that shows what is prescribed now for this event: received on or after the admission, transfer
 * or return, or marked current by the person with a reason. A line that says something else, or is
 * about another product, never supports a decision; an unclear line is a question to answer first.
 * Harbour never infers a stop from a medicine missing from a source, and never pairs lines itself.
 * Allergies in the sources are compared with the recorded allergies by the person, who confirms
 * it; Harbour matches no allergen (ADR-0082 default).
 *
 * A change keeps the same dm+d product; switching products is a stop on the old product's line and
 * a start on the new one's. One entry of a product is on the MAR at a time.
 *
 * New and changed medicines become MAR entries "Not yet checked", so a second person checks each
 * against its source (HZ-005). Each change, stop and start is tried against the medicine's
 * versions when the reconciliation completes (a restart against the person's earlier entries of
 * the product), so anything the MAR rules refuse shows then, not when the plan is applied. The
 * completed reconciliation is the plan the API applies.
 */

import { formatUkDateTime } from "../shared/time";
import { type DmdProductRef, dmdProductDifference } from "./dmd";
import {
  changeMarEntry,
  checkMarEntryDraft,
  type DmdProductFacts,
  type MarEntry,
  type MarEntryDraft,
  type MarEntryIssue,
  type MarEntryStop,
  type MarSourceDocument,
  type MarSourceKind,
  type MedicinesCompetence,
  marEntryEnd,
  stopMarEntry,
  transcribeMarEntry,
  versionInForceAt,
} from "./mar-entry";

export type ReconciliationTrigger = "admission" | "transfer" | "return_from_hospital" | "change";

export const RECONCILIATION_TRIGGER_WORDS: Readonly<Record<ReconciliationTrigger, string>> = {
  admission: "admission",
  transfer: "transfer",
  return_from_hospital: "return from hospital",
  change: "change to medicines",
};

/**
 * The documents a MAR entry can come from, plus what the person or their family says. The person
 * and family are always asked, but what they say is not enough on its own to start, change or
 * stop a medicine: a document is (medicines.md rule 9; H-552). Medicines brought in are recorded
 * by their pharmacy labels (`pharmacy_label`).
 */
export type ReconciliationSourceKind = MarSourceKind | "person_or_family";

/**
 * Sources that can show what is prescribed now: what the prescriber or the pharmacy records. The
 * labels on medicines brought in, the previous setting's MAR and what the person or family say show
 * what was taken, not what is prescribed now (rule 7).
 */
const SHOWS_CURRENT_PRESCRIPTION: ReadonlySet<ReconciliationSourceKind> = new Set([
  "prescription",
  "pharmacy_mar",
  "discharge_letter",
  "transfer_letter",
  "gp_record",
  "clinic_letter",
  "prescriber_instruction",
]);

export interface ReconciliationSource {
  readonly id: string;
  readonly kind: ReconciliationSourceKind;
  readonly reference: string;
  readonly documentId: string | null;
  readonly receivedAt: Date;
  /**
   * Why a source received before the admission, transfer or return still shows what is prescribed
   * now (for example "GP summary printed for this admission on 30/09"); null otherwise (rule 9).
   */
  readonly currentBecause: string | null;
}

/** What a source line says about the medicine, as the person recording it reads it. */
export type LineSays = "start" | "continue" | "change" | "stop" | "unclear";

export const LINE_SAYS_WORDS: Readonly<Record<LineSays, string>> = {
  start: "start it",
  continue: "continue it",
  change: "change it",
  stop: "stop it",
  unclear: "it is unclear",
};

/** One medicine as a source lists it: as written, its dm+d product, and what it says. */
export interface ReconciliationItem {
  readonly id: string;
  readonly sourceId: string;
  readonly asWritten: string;
  readonly product: DmdProductRef | null;
  readonly says: LineSays;
}

/** A MAR entry to decide on, as the reconciliation sees it (`entriesToReconcile`). */
export interface ReconciledEntry {
  readonly entryId: string;
  readonly version: number;
  readonly personId: string;
  readonly product: DmdProductRef;
}

/** A draft from a reconciliation: the person and the source document come from the reconciliation. */
export type ReconciliationDraft = Omit<MarEntryDraft, "personId" | "source">;

export type EntryDecision =
  | {
      readonly kind: "continue";
      readonly entryId: string;
      readonly itemIds: readonly string[];
      /** Why it continues when no linked line shows the current prescription, or one shows another brand. */
      readonly note: string | null;
      /** Who confirmed it continues (the prescriber or a clinician), how and when, when no linked line shows it. */
      readonly confirmedWith: string | null;
      /**
       * Why a change or stop scheduled before this reconciliation still stands against the
       * sources; without it, continuing a medicine with one scheduled is refused.
       */
      readonly scheduledStillStands?: string | null;
    }
  | {
      readonly kind: "change";
      readonly entryId: string;
      /** The lines that say the change, about the same dm+d product (a change keeps the VMP). */
      readonly itemIds: readonly string[];
      readonly draft: ReconciliationDraft;
      /** Why the new pattern starts a new day count, when it does (rule 6a). */
      readonly reanchorReason?: string | null;
      /** Why a version scheduled to start later is withdrawn by this change (rule 6b). */
      readonly withdrawLaterReason?: string | null;
      /**
       * Why a version or stop scheduled before this reconciliation, which this change keeps (a
       * version starting before the change, a stop still to come), still stands against the
       * sources; without it the change is refused.
       */
      readonly scheduledStillStands?: string | null;
    }
  | {
      readonly kind: "stop";
      readonly entryId: string;
      /** The lines that say the medicine stops: never absence. */
      readonly itemIds: readonly string[];
      readonly reason: string;
      /** Why a version scheduled to start later is withdrawn, or a later stop replaced (rule 6b). */
      readonly withdrawLaterReason?: string | null;
    }
  | { readonly kind: "query"; readonly entryId: string; readonly question: string };

export type ItemDecision =
  | {
      readonly kind: "start";
      readonly itemId: string;
      readonly draft: ReconciliationDraft;
      /** Why a restart of a product the person had before starts a new day count (rule 6a). */
      readonly reanchorReason?: string | null;
      /** Why the doses earlier on the day it is recorded may still be needed (the same-day route, rule 6). */
      readonly earlierDosesDueReason?: string | null;
    }
  | { readonly kind: "not_started"; readonly itemId: string; readonly reason: string }
  | { readonly kind: "query"; readonly itemId: string; readonly question: string };

export interface Reconciliation {
  readonly id: string;
  readonly personId: string;
  readonly trigger: ReconciliationTrigger;
  /** When the admission, transfer or return happened, or the change was known. */
  readonly triggeredAt: Date;
  /** The MAR entries to decide on when it began (`entriesToReconcile` then), with their versions. */
  readonly entriesAtStart: readonly { readonly entryId: string; readonly version: number }[];
  readonly sources: readonly ReconciliationSource[];
  readonly items: readonly ReconciliationItem[];
}

export interface ReconciliationCompletion {
  readonly reconciliation: Reconciliation;
  /**
   * The person's MAR entries to decide on now, from `entriesToReconcile` over every version of
   * their entries: worked out from dates, never by state (a version whose stop or replacement is
   * still to come is `stopped` or `replaced` already, but still in force).
   */
  readonly currentEntries: readonly ReconciledEntry[];
  /** Every version of an entry's medicine, to try each change and stop against. */
  readonly entryVersions: (entryId: string) => readonly MarEntry[];
  /**
   * Every version of the person's entries of a dm+d product, stopped and withdrawn ones included,
   * to try each start against (one entry per product; a restart's day count and day).
   */
  readonly earlierEntries: (product: DmdProductRef) => readonly MarEntry[];
  readonly entryDecisions: readonly EntryDecision[];
  readonly itemDecisions: readonly ItemDecision[];
  /** Read on the server from the workforce port, never from the request (section 3). */
  readonly completer: { readonly id: string; readonly competence: MedicinesCompetence };
  readonly completedAt: Date;
  /** The completer compared the allergies in the sources with the recorded allergies. */
  readonly allergiesCompared: boolean;
  readonly personInvolvement:
    | { readonly involved: true }
    | { readonly involved: false; readonly reason: string };
  /** On a return from hospital with no discharge letter among the sources: why, and what was done. */
  readonly noDischargeLetterReason: string | null;
  /** dm+d facts for each product a draft names, by VMP id. */
  readonly dmdFacts: (product: DmdProductRef) => DmdProductFacts;
}

export type ReconciliationProblem =
  | "completer_not_competent"
  | "no_sources"
  | "source_reference_required"
  | "return_without_discharge_letter"
  | "wrong_person"
  | "record_changed"
  | "entry_undecided"
  | "entry_decided_twice"
  | "unknown_entry"
  | "item_undecided"
  | "item_decided_twice"
  | "unknown_item"
  | "line_unclear"
  | "line_does_not_support"
  | "source_not_a_document"
  | "continue_not_in_sources"
  | "continue_not_shown_current"
  | "continue_with_difference"
  | "continue_with_later_scheduled"
  | "change_needs_source_item"
  | "change_different_product"
  | "change_not_shown_current"
  | "change_refused"
  | "change_with_later_scheduled"
  | "stop_needs_source_item"
  | "stop_not_shown_current"
  | "stop_needs_reason"
  | "stop_refused"
  | "start_not_shown_current"
  | "start_refused"
  | "not_started_needs_reason"
  | "query_open"
  | "draft_invalid"
  | "duplicate_product"
  | "allergies_not_compared"
  | "involvement_reason_required";

export interface ReconciliationIssue {
  readonly problem: ReconciliationProblem;
  readonly message: string;
  readonly entryId?: string;
  readonly itemId?: string;
  readonly draftIssues?: readonly MarEntryIssue[];
}

export interface ReconciliationPlan {
  readonly continued: readonly string[];
  /** New versions, made "Not yet checked" with origin `reconciliation` through `changeMarEntry`. */
  readonly changes: readonly {
    readonly entryId: string;
    readonly draft: MarEntryDraft;
    readonly reanchorReason: string | null;
    readonly withdrawLaterReason: string | null;
    readonly scheduledStillStands: string | null;
  }[];
  /** Stops from when the reconciliation completes, through `stopMarEntry`. */
  readonly stops: readonly {
    readonly entryId: string;
    readonly reason: string;
    readonly source: MarSourceDocument;
    readonly withdrawLaterReason: string | null;
  }[];
  /** New entries, made "Not yet checked" with origin `reconciliation` through `transcribeMarEntry`. */
  readonly starts: readonly {
    readonly itemId: string;
    readonly draft: MarEntryDraft;
    readonly reanchorReason: string | null;
    readonly earlierDosesDueReason: string | null;
  }[];
  readonly notStarted: readonly { readonly itemId: string; readonly reason: string }[];
  readonly completedBy: string;
  readonly completedAt: Date;
}

export type ReconciliationOutcome =
  | { readonly ok: true; readonly plan: ReconciliationPlan }
  | { readonly ok: false; readonly issues: readonly ReconciliationIssue[] };

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

const reasonOrNull = (value: string | null | undefined): string | null =>
  blank(value) ? null : (value as string).trim();

/**
 * The MAR entries a reconciliation decides on, from every version of the person's entries: for
 * each medicine (dm+d VMP), the version in force at `at` or, when none is, the first scheduled to
 * start after it. Worked out from dates, never from `state`, because a version whose stop or
 * replacement is still to come is already `stopped` or `replaced` but still in force: the API
 * builds `entriesAtStart` and `currentEntries` with this and never filters versions by state.
 */
export function entriesToReconcile(
  versions: readonly MarEntry[],
  at: Date,
): readonly ReconciledEntry[] {
  const byMedicine = new Map<string, MarEntry[]>();
  for (const v of versions) {
    const key = `${v.personId}|${v.product.vmpId}`;
    byMedicine.set(key, [...(byMedicine.get(key) ?? []), v]);
  }
  const chosen: MarEntry[] = [];
  for (const medicine of byMedicine.values()) {
    const scheduled = medicine
      .filter((v) => v.withdrawn === null && v.startsAt.getTime() > at.getTime())
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const v = versionInForceAt(medicine, at) ?? scheduled[0];
    if (v) chosen.push(v);
  }
  return chosen.map((v) => ({
    entryId: v.id,
    version: v.version,
    personId: v.personId,
    product: v.product,
  }));
}

/** What was scheduled for a medicine after an instant: later versions, and the first stop still to come. */
function scheduledAfter(
  versions: readonly MarEntry[],
  at: Date,
): { readonly versions: readonly MarEntry[]; readonly stop: MarEntryStop | null } {
  const live = versions.filter((v) => v.withdrawn === null);
  const stop =
    live
      .map((v) => v.stop)
      .filter((st): st is MarEntryStop => st !== null && st.effectiveAt.getTime() > at.getTime())
      .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime())[0] ?? null;
  return {
    versions: live
      .filter((v) => v.startsAt.getTime() > at.getTime())
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()),
    stop,
  };
}

/** The scheduled items in words, joined: "Version 2 starts ...; a stop is recorded from ...". */
function scheduledWords(versions: readonly MarEntry[], stop: MarEntryStop | null): string | null {
  const words = [
    ...versions.map((v) => `Version ${v.version} starts ${formatUkDateTime(v.startsAt)}`),
    ...(stop ? [`a stop is recorded from ${formatUkDateTime(stop.effectiveAt)}`] : []),
  ].join("; ");
  return words === "" ? null : words.charAt(0).toUpperCase() + words.slice(1);
}

/** When a medicine's last live version ends; null when it has no end. */
function chainEnd(versions: readonly MarEntry[]): Date | null {
  const ends = versions.filter((v) => v.withdrawn === null).map((v) => marEntryEnd(v));
  if (ends.length === 0 || ends.some((e) => e === null)) return null;
  return new Date(Math.max(...ends.map((e) => (e as Date).getTime())));
}

/** How a source line differs from the MAR entry it is linked to, by dm+d identity only. */
export function linkDifference(
  entry: ReconciledEntry,
  item: ReconciliationItem,
): "product" | "brand" | "not_coded" | null {
  if (item.product === null) return "not_coded";
  return dmdProductDifference(entry.product, item.product);
}

/** The source as the MAR entry's source document; null for what the person or family says. */
function asMarSource(source: ReconciliationSource): MarSourceDocument | null {
  if (source.kind === "person_or_family") return null;
  return { kind: source.kind, reference: source.reference, documentId: source.documentId };
}

const NOT_A_DOCUMENT =
  "What the person or family says is not enough on its own. Link a prescription, letter or record.";

function sameEntries(
  atStart: Reconciliation["entriesAtStart"],
  now: readonly ReconciledEntry[],
): boolean {
  const key = (e: { entryId: string; version: number }) => `${e.entryId}@${e.version}`;
  const a = new Set(atStart.map(key));
  const b = new Set(now.map(key));
  return a.size === b.size && [...a].every((k) => b.has(k));
}

/**
 * Checks a reconciliation for completion and returns the plan, or every reason it cannot complete
 * yet. Every medicine on the MAR and every medicine in the sources needs a decision a person made,
 * supported by a line that says it; a query or an unclear line blocks completion until answered.
 */
export function completeReconciliation(input: ReconciliationCompletion): ReconciliationOutcome {
  const rec = input.reconciliation;
  const issues: ReconciliationIssue[] = [];
  const add = (issue: ReconciliationIssue) => issues.push(issue);

  if (input.completer.competence !== "current") {
    add({
      problem: "completer_not_competent",
      message: "Only someone whose medicines competence is current can complete a reconciliation.",
    });
  }
  if (rec.sources.length === 0) {
    add({ problem: "no_sources", message: "Add the sources the medicines were checked against." });
  }
  if (rec.sources.some((s) => blank(s.reference))) {
    add({ problem: "source_reference_required", message: "Say what each source is." });
  }
  const hasLetter = rec.sources.some((s) => s.kind === "discharge_letter");
  if (
    rec.trigger === "return_from_hospital" &&
    !hasLetter &&
    blank(input.noDischargeLetterReason)
  ) {
    add({
      problem: "return_without_discharge_letter",
      message:
        "Add the hospital discharge letter, or say why there is none and how the medicines were confirmed.",
    });
  }
  if (input.currentEntries.some((e) => e.personId !== rec.personId)) {
    add({ problem: "wrong_person", message: "An entry belongs to someone else. Start again." });
  }
  if (!sameEntries(rec.entriesAtStart, input.currentEntries)) {
    add({
      problem: "record_changed",
      message:
        "The medicines record changed after this reconciliation began. Review the new or changed entries before completing it.",
    });
  }
  for (const item of rec.items.filter((i) => i.says === "unclear")) {
    add({
      problem: "line_unclear",
      itemId: item.id,
      message: `"${item.asWritten}" is unclear. Ask the prescriber or the ward, then record what it says.`,
    });
  }

  const entries = new Map(input.currentEntries.map((e) => [e.entryId, e]));
  const items = new Map(rec.items.map((i) => [i.id, i]));
  const sources = new Map(rec.sources.map((s) => [s.id, s]));
  const itemUses = new Map<string, number>();
  const useItem = (itemId: string) => {
    if (!items.has(itemId))
      add({
        problem: "unknown_item",
        itemId,
        message: "A source line is not part of this reconciliation.",
      });
    itemUses.set(itemId, (itemUses.get(itemId) ?? 0) + 1);
  };
  const decidedEntries = new Map<string, number>();

  /** A source received for this event, or marked current by the person with a reason (rule 9). */
  const isCurrent = (source: ReconciliationSource) =>
    source.receivedAt.getTime() >= rec.triggeredAt.getTime() || !blank(source.currentBecause);
  /** A line from a current document that shows what is prescribed now; on a return with a letter, for a continue, only the letter. */
  const showsCurrent = (item: ReconciliationItem, onlyLetter: boolean) => {
    const source = sources.get(item.sourceId);
    if (!source || !isCurrent(source)) return false;
    if (onlyLetter) return source.kind === "discharge_letter";
    return SHOWS_CURRENT_PRESCRIPTION.has(source.kind);
  };
  const fromDocument = (item: ReconciliationItem) => {
    const source = sources.get(item.sourceId);
    return source !== undefined && asMarSource(source) !== null;
  };
  const about = (item: ReconciliationItem, product: DmdProductRef) =>
    item.product !== null && item.product.vmpId === product.vmpId;
  const otherProduct = (item: ReconciliationItem, product: DmdProductRef) =>
    item.product !== null && item.product.vmpId !== product.vmpId;
  const doesNotSupport = (item: ReconciliationItem, what: string) =>
    `"${item.asWritten}" says ${LINE_SAYS_WORDS[item.says]}${item.product ? ` (${item.product.name})` : ""}, so it cannot support ${what}.`;

  const draftFor = (
    draft: ReconciliationDraft,
    source: ReconciliationSource | undefined,
    where: { entryId?: string; itemId?: string },
  ): MarEntryDraft | null => {
    const marSource = source ? asMarSource(source) : null;
    if (!marSource) {
      add({ problem: "source_not_a_document", ...where, message: NOT_A_DOCUMENT });
      return null;
    }
    const full: MarEntryDraft = { ...draft, personId: rec.personId, source: marSource };
    const draftIssues = checkMarEntryDraft(full, input.dmdFacts(full.product));
    if (draftIssues.length > 0) {
      add({
        problem: "draft_invalid",
        ...where,
        draftIssues,
        message: "The new entry needs correcting before the reconciliation completes.",
      });
      return null;
    }
    return full;
  };

  /** When each changed entry ends after the plan, for the duplicate check. */
  const changedEnds = new Map<string, Date | null>();
  const plan = {
    continued: [] as string[],
    changes: [] as ReconciliationPlan["changes"][number][],
    stops: [] as ReconciliationPlan["stops"][number][],
    starts: [] as ReconciliationPlan["starts"][number][],
    notStarted: [] as ReconciliationPlan["notStarted"][number][],
  };
  const dryRun = {
    by: input.completer.id,
    at: input.completedAt,
    origin: "reconciliation" as const,
  };

  for (const decision of input.entryDecisions) {
    const entry = entries.get(decision.entryId);
    const entryId = decision.entryId;
    decidedEntries.set(entryId, (decidedEntries.get(entryId) ?? 0) + 1);
    if (!entry) {
      add({
        problem: "unknown_entry",
        entryId,
        message: "A decision is for an entry not on the MAR now.",
      });
      continue;
    }
    if (decision.kind === "query") {
      add({
        problem: "query_open",
        entryId,
        message: blank(decision.question)
          ? "Write the question about this medicine, and complete once it is answered."
          : "A question about this medicine is still open. Complete once it is answered.",
      });
      continue;
    }
    for (const itemId of decision.itemIds) useItem(itemId);
    const linked = decision.itemIds.map((id) => items.get(id)).filter((i) => i !== undefined);

    if (decision.kind === "continue") {
      const against = linked.find((i) => i.says !== "continue" || otherProduct(i, entry.product));
      const confirmed = !blank(decision.note) && !blank(decision.confirmedWith);
      const onlyLetter = rec.trigger === "return_from_hospital" && hasLetter;
      if (against) {
        add({
          problem: "line_does_not_support",
          entryId,
          itemId: against.id,
          message: doesNotSupport(against, `continuing ${entry.product.name}`),
        });
      } else if (linked.length === 0 && !confirmed) {
        add({
          problem: "continue_not_in_sources",
          entryId,
          message:
            "No source lists this medicine. Link the line that says it continues, or say how continuing it was confirmed and which prescriber or clinician confirmed it.",
        });
      } else if (
        !linked.some((i) => about(i, entry.product) && showsCurrent(i, onlyLetter)) &&
        !confirmed
      ) {
        add({
          problem: "continue_not_shown_current",
          entryId,
          message: onlyLetter
            ? "Only the discharge letter shows what is prescribed after this stay. Link its line, or say how continuing it was confirmed and which prescriber or clinician confirmed it."
            : "No linked line, from a current prescription, letter or record, shows it continues. Link one, or say how continuing it was confirmed and which prescriber or clinician confirmed it.",
        });
      } else if (linked.some((i) => linkDifference(entry, i) === "brand") && blank(decision.note)) {
        add({
          problem: "continue_with_difference",
          entryId,
          message:
            "A linked line names another brand of this medicine. Say why the MAR entry continues unchanged, or record a change.",
        });
      } else {
        const later = scheduledAfter(input.entryVersions(entryId), input.completedAt);
        const scheduled = scheduledWords(later.versions, later.stop);
        if (scheduled && blank(decision.scheduledStillStands)) {
          add({
            problem: "continue_with_later_scheduled",
            entryId,
            message: `${scheduled}, recorded before this reconciliation. Check it against the sources: change or stop the medicine, or say why it still stands.`,
          });
        } else plan.continued.push(entryId);
      }
    } else if (decision.kind === "change") {
      const product = decision.draft.product;
      const against = linked.find((i) => i.says !== "change" || otherProduct(i, product));
      const supporting = linked.find((i) => about(i, product) && showsCurrent(i, false));
      if (product.vmpId !== entry.product.vmpId) {
        add({
          problem: "change_different_product",
          entryId,
          message: `A change keeps the same medicine. To switch from ${entry.product.name} to ${product.name}, stop ${entry.product.name} on the line that says it stops, and start ${product.name} on its own line.`,
        });
      } else if (linked.length === 0) {
        add({
          problem: "change_needs_source_item",
          entryId,
          message: "Link the line that says the change.",
        });
      } else if (against) {
        add({
          problem: "line_does_not_support",
          entryId,
          itemId: against.id,
          message: doesNotSupport(against, `this change`),
        });
      } else if (!supporting) {
        add({
          problem: "change_not_shown_current",
          entryId,
          message:
            "No linked line, about the new product and from a current prescription, letter or record, shows the change.",
        });
      } else {
        const draft = draftFor(decision.draft, sources.get(supporting.sourceId), { entryId });
        const reanchorReason = reasonOrNull(decision.reanchorReason);
        const withdrawLaterReason = reasonOrNull(decision.withdrawLaterReason);
        if (draft) {
          const tried = changeMarEntry(
            input.entryVersions(entryId),
            draft,
            input.dmdFacts(draft.product),
            { ...dryRun, id: `planned-${entryId}`, reanchorReason, withdrawLaterReason },
          );
          const later = scheduledAfter(input.entryVersions(entryId), input.completedAt);
          const withdrawn = new Set(tried.ok ? tried.withdrawn.map((v) => v.id) : []);
          const keptVersions = later.versions.filter((v) => !withdrawn.has(v.id));
          const keeps = scheduledWords(keptVersions, later.stop);
          const handle =
            keptVersions.length > 0
              ? "start the change before a scheduled version to withdraw it, with the reason, or say why it still stands."
              : "a change never cancels a stop, so say why it still stands, or stop the medicine instead.";
          const scheduledStillStands = reasonOrNull(decision.scheduledStillStands);
          if (!tried.ok) {
            add({
              problem: "change_refused",
              entryId,
              draftIssues: tried.issues,
              message: tried.issues.map((i) => i.message).join(" "),
            });
          } else if (keeps && scheduledStillStands === null) {
            add({
              problem: "change_with_later_scheduled",
              entryId,
              message: `${keeps}, recorded before this reconciliation, and this change keeps it. Check it against the sources: ${handle}`,
            });
          } else {
            plan.changes.push({
              entryId,
              draft,
              reanchorReason,
              withdrawLaterReason,
              scheduledStillStands,
            });
            changedEnds.set(entryId, marEntryEnd(tried.next));
          }
        }
      }
    } else {
      const against = linked.find((i) => i.says !== "stop" || otherProduct(i, entry.product));
      const documents = linked.filter(fromDocument);
      const supporting = documents.find((i) => about(i, entry.product) && showsCurrent(i, false));
      if (linked.length === 0) {
        add({
          problem: "stop_needs_source_item",
          entryId,
          message:
            "Link the line that says the medicine stops: a letter's line or the prescriber's instruction. A medicine missing from a source is a question, not a stop.",
        });
      } else if (against) {
        add({
          problem: "line_does_not_support",
          entryId,
          itemId: against.id,
          message: doesNotSupport(against, `stopping ${entry.product.name}`),
        });
      } else if (documents.length === 0) {
        add({ problem: "source_not_a_document", entryId, message: NOT_A_DOCUMENT });
      } else if (!supporting) {
        add({
          problem: "stop_not_shown_current",
          entryId,
          message: "No linked line, from a current prescription, letter or record, says it stops.",
        });
      } else if (blank(decision.reason)) {
        add({
          problem: "stop_needs_reason",
          entryId,
          message: "Say why the medicine stops, as the source says.",
        });
      } else {
        const source = asMarSource(
          sources.get(supporting.sourceId) as ReconciliationSource,
        ) as MarSourceDocument;
        const withdrawLaterReason = reasonOrNull(decision.withdrawLaterReason);
        const tried = stopMarEntry(
          input.entryVersions(entryId),
          {
            by: input.completer.id,
            at: input.completedAt,
            effectiveAt: input.completedAt,
            reason: decision.reason,
            source,
          },
          { withdrawLaterReason },
        );
        if (!tried.ok) {
          add({
            problem: "stop_refused",
            entryId,
            draftIssues: tried.issues,
            message: tried.issues.map((i) => i.message).join(" "),
          });
        } else plan.stops.push({ entryId, reason: decision.reason, source, withdrawLaterReason });
      }
    }
  }

  for (const decision of input.itemDecisions) {
    const itemId = decision.itemId;
    useItem(itemId);
    const item = items.get(itemId);
    if (!item) continue;
    if (decision.kind === "query") {
      add({
        problem: "query_open",
        itemId,
        message: "A question about this source line is still open. Complete once it is answered.",
      });
    } else if (decision.kind === "not_started") {
      if (blank(decision.reason)) {
        add({
          problem: "not_started_needs_reason",
          itemId,
          message: "Say why this medicine from the source is not started.",
        });
      } else plan.notStarted.push({ itemId, reason: decision.reason });
    } else if (
      item.says === "stop" ||
      item.says === "unclear" ||
      !about(item, decision.draft.product)
    ) {
      add({
        problem: "line_does_not_support",
        itemId,
        message: doesNotSupport(item, `starting ${decision.draft.product.name}`),
      });
    } else if (!fromDocument(item)) {
      add({ problem: "source_not_a_document", itemId, message: NOT_A_DOCUMENT });
    } else if (!showsCurrent(item, false)) {
      add({
        problem: "start_not_shown_current",
        itemId,
        message:
          "This line is not from a current prescription, letter or record. Confirm the medicine with the prescriber and record their instruction as a source.",
      });
    } else {
      const draft = draftFor(decision.draft, sources.get(item.sourceId), { itemId });
      const reanchorReason = reasonOrNull(decision.reanchorReason);
      const earlierDosesDueReason = reasonOrNull(decision.earlierDosesDueReason);
      if (draft) {
        const tried = transcribeMarEntry(draft, input.dmdFacts(draft.product), {
          ...dryRun,
          id: `planned-${itemId}`,
          earlierEntries: input.earlierEntries(draft.product),
          reanchorReason,
          earlierDosesDueReason,
        });
        if (!tried.ok) {
          add({
            problem: "start_refused",
            itemId,
            draftIssues: tried.issues,
            message: tried.issues.map((i) => i.message).join(" "),
          });
        } else plan.starts.push({ itemId, draft, reanchorReason, earlierDosesDueReason });
      }
    }
  }

  // One entry per dm+d product (VMP) on the MAR after the plan, by identity, never by ingredient
  // (H-553): a start beside an entry of the same VMP that continues or changes is refused unless it
  // starts on or after that entry's end (a course extended by the source, rule 10), and so is a
  // second start of it.
  const kept = [
    ...plan.continued.map((id) => ({
      vmpId: entries.get(id)?.product.vmpId,
      end: chainEnd(input.entryVersions(id)),
    })),
    ...plan.changes.map((c) => ({
      vmpId: c.draft.product.vmpId,
      end: changedEnds.get(c.entryId) ?? null,
    })),
  ];
  plan.starts.forEach((start, i) => {
    const vmpId = start.draft.product.vmpId;
    const overlaps = kept.some(
      (k) =>
        k.vmpId === vmpId && (k.end === null || k.end.getTime() > start.draft.startsAt.getTime()),
    );
    if (overlaps || plan.starts.slice(0, i).some((s) => s.draft.product.vmpId === vmpId)) {
      add({
        problem: "duplicate_product",
        itemId: start.itemId,
        message: `${start.draft.product.name} is already on the MAR after this reconciliation. Link the line to that entry and change it, rather than starting a second entry.`,
      });
    }
  });

  for (const entry of input.currentEntries) {
    const count = decidedEntries.get(entry.entryId) ?? 0;
    if (count === 0) {
      add({
        problem: "entry_undecided",
        entryId: entry.entryId,
        message: `Decide what happens to ${entry.product.name}: continue, change, stop or ask.`,
      });
    } else if (count > 1) {
      add({
        problem: "entry_decided_twice",
        entryId: entry.entryId,
        message: `${entry.product.name} has more than one decision.`,
      });
    }
  }
  for (const item of rec.items) {
    const count = itemUses.get(item.id) ?? 0;
    if (count === 0) {
      add({
        problem: "item_undecided",
        itemId: item.id,
        message: `Decide what happens to "${item.asWritten}": link it to a MAR entry, start it, or say why not.`,
      });
    } else if (count > 1) {
      add({
        problem: "item_decided_twice",
        itemId: item.id,
        message: `"${item.asWritten}" is used by more than one decision.`,
      });
    }
  }

  if (!input.allergiesCompared) {
    add({
      problem: "allergies_not_compared",
      message:
        "Compare the allergies in the sources with the person's recorded allergies, and record any new ones, before completing.",
    });
  }
  if (!input.personInvolvement.involved && blank(input.personInvolvement.reason)) {
    add({
      problem: "involvement_reason_required",
      message: "Say why the person, or someone who speaks for them, was not involved.",
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    plan: { ...plan, completedBy: input.completer.id, completedAt: input.completedAt },
  };
}

/** An admission, transfer or return from hospital that needs a reconciliation. */
export interface ReconciliationTriggerEvent {
  readonly id: string;
  readonly personId: string;
  readonly kind: Exclude<ReconciliationTrigger, "change">;
  readonly at: Date;
}

export interface CompletedReconciliationRef {
  readonly personId: string;
  /** The admission, transfer or return the reconciliation was for; null for a change. */
  readonly triggerEventId: string | null;
}

export interface OutstandingReconciliation {
  readonly event: ReconciliationTriggerEvent;
  readonly notice: string;
}

/**
 * The admissions, transfers and returns from hospital whose medicines are not yet reconciled, so
 * the medicines record and the round say so until they are. A reconciliation completed for an
 * event also covers that person's earlier events (it compared the MAR as it then stood); one
 * completed for a change covers none, because it did not look at the discharge or transfer
 * sources.
 */
export function outstandingReconciliations(
  events: readonly ReconciliationTriggerEvent[],
  completed: readonly CompletedReconciliationRef[],
): readonly OutstandingReconciliation[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const latestCovered = new Map<string, number>();
  for (const c of completed) {
    const event = c.triggerEventId === null ? undefined : byId.get(c.triggerEventId);
    if (!event || event.personId !== c.personId) continue;
    latestCovered.set(
      c.personId,
      Math.max(latestCovered.get(c.personId) ?? -Infinity, event.at.getTime()),
    );
  }
  return events
    .filter((e) => e.at.getTime() > (latestCovered.get(e.personId) ?? -Infinity))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((event) => ({
      event,
      notice: `Medicines not yet reconciled since the ${RECONCILIATION_TRIGGER_WORDS[event.kind]} on ${formatUkDateTime(event.at)}.`,
    }));
}

/**
 * Medicines reconciliation (medicines.md rules 7 to 12; HZ-121, HZ-005). When a person is
 * admitted, transferred or returns from hospital, or their medicines change, a competent member
 * of staff compares the MAR with the sources (the discharge letter, the GP record, the previous
 * MAR, the medicines that came with the person, what the person and family say) and decides, for
 * every medicine on the MAR and every medicine in the sources, what happens to it.
 *
 * Harbour decides nothing itself. It never infers that a medicine stopped because a source leaves
 * it out, and it never pairs medicines: the person links each source line to the MAR entry it is
 * about. On a link, Harbour shows only whether the dm+d product differs by identity (another VMP,
 * or another brand of the same VMP), never by ingredient (medical-device boundary). Allergies in
 * the sources are compared with the recorded allergies by the person, who confirms it; Harbour
 * matches no allergen (ADR-0082 default).
 *
 * New and changed medicines become MAR entries "Not yet checked", so a second person checks each
 * against its source (HZ-005). The completed reconciliation is the plan the API applies.
 */

import { formatUkDateTime } from "../shared/time";
import { type DmdProductRef, dmdProductDifference } from "./dmd";
import {
  checkMarEntryDraft,
  type DmdProductFacts,
  type MarEntryDraft,
  type MarEntryIssue,
  type MarSourceDocument,
  type MarSourceKind,
  type MedicinesCompetence,
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
 * Sources that can show on their own that a medicine continues: what the prescriber or the
 * pharmacy records as prescribed now. The labels on medicines brought in, the previous setting's
 * MAR and what the person or family say show what was taken, not what is prescribed now, so a
 * medicine supported only by them needs a note and a clinician's confirmation (rule 7).
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
}

/** One medicine as a source lists it, written as it is there; dm+d coded when it can be. */
export interface ReconciliationItem {
  readonly id: string;
  readonly sourceId: string;
  readonly asWritten: string;
  readonly product: DmdProductRef | null;
}

/** A MAR entry in force, as the reconciliation sees it. */
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
      /** Why it continues when no linked line shows the current prescription, or one shows another product. */
      readonly note: string | null;
      /** Who confirmed it continues (the prescriber or a clinician), how and when, when no linked line shows the current prescription. */
      readonly confirmedWith: string | null;
    }
  | {
      readonly kind: "change";
      readonly entryId: string;
      readonly itemIds: readonly string[];
      readonly draft: ReconciliationDraft;
      /** Why the new pattern starts a new day count, when it does (rule 6a). */
      readonly reanchorReason?: string | null;
    }
  | {
      readonly kind: "stop";
      readonly entryId: string;
      /** The source lines that say the medicine stops (a letter's line, the prescriber's instruction): never absence. */
      readonly itemIds: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: "query"; readonly entryId: string; readonly question: string };

export type ItemDecision =
  | {
      readonly kind: "start";
      readonly itemId: string;
      readonly draft: ReconciliationDraft;
      /** Why it is started when the MAR will already hold the same dm+d product (rule 10). */
      readonly note?: string | null;
    }
  | { readonly kind: "not_started"; readonly itemId: string; readonly reason: string }
  | { readonly kind: "query"; readonly itemId: string; readonly question: string };

export interface Reconciliation {
  readonly id: string;
  readonly personId: string;
  readonly trigger: ReconciliationTrigger;
  /** When the admission, transfer or return happened, or the change was known. */
  readonly triggeredAt: Date;
  /** The MAR entries in force when it began, with their versions. */
  readonly entriesAtStart: readonly { readonly entryId: string; readonly version: number }[];
  readonly sources: readonly ReconciliationSource[];
  readonly items: readonly ReconciliationItem[];
}

export interface ReconciliationCompletion {
  readonly reconciliation: Reconciliation;
  /** The person's MAR entries in force now (not stopped or replaced). */
  readonly currentEntries: readonly ReconciledEntry[];
  readonly entryDecisions: readonly EntryDecision[];
  readonly itemDecisions: readonly ItemDecision[];
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
  | "unknown_source"
  | "source_not_a_document"
  | "continue_not_in_sources"
  | "continue_not_shown_current"
  | "continue_with_difference"
  | "change_needs_source_item"
  | "stop_needs_source_item"
  | "stop_needs_reason"
  | "possible_duplicate"
  | "not_started_needs_reason"
  | "query_open"
  | "draft_invalid"
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
  /** New versions, made "Not yet checked" with origin `reconciliation` (`changeMarEntry`, with the reason when the day count moves). */
  readonly changes: readonly {
    readonly entryId: string;
    readonly draft: MarEntryDraft;
    readonly reanchorReason: string | null;
  }[];
  readonly stops: readonly {
    readonly entryId: string;
    readonly reason: string;
    readonly source: MarSourceDocument;
  }[];
  /** New entries, made "Not yet checked" with origin `reconciliation`. */
  readonly starts: readonly { readonly itemId: string; readonly draft: MarEntryDraft }[];
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
  "What the person or family says is not enough on its own. Link a prescription, label, letter or record.";

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
 * yet. Every medicine on the MAR and every medicine in the sources needs a decision a person made;
 * a query blocks completion until it is answered.
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
  if (
    rec.trigger === "return_from_hospital" &&
    !rec.sources.some((s) => s.kind === "discharge_letter") &&
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
  const draftFor = (
    draft: ReconciliationDraft,
    source: ReconciliationSource | undefined,
    where: { entryId?: string; itemId?: string },
  ): MarEntryDraft | null => {
    if (!source) return null;
    const marSource = asMarSource(source);
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

  const hasLetter = rec.sources.some((s) => s.kind === "discharge_letter");
  /** On a return with a discharge letter only the letter shows what is prescribed now. */
  const showsCurrent = (item: ReconciliationItem) => {
    const source = sources.get(item.sourceId);
    if (!source) return false;
    if (rec.trigger === "return_from_hospital" && hasLetter)
      return source.kind === "discharge_letter";
    return SHOWS_CURRENT_PRESCRIPTION.has(source.kind);
  };
  const plan = {
    continued: [] as string[],
    changes: [] as { entryId: string; draft: MarEntryDraft; reanchorReason: string | null }[],
    stops: [] as { entryId: string; reason: string; source: MarSourceDocument }[],
    starts: [] as { itemId: string; draft: MarEntryDraft }[],
    notStarted: [] as { itemId: string; reason: string }[],
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
      const confirmed = !blank(decision.note) && !blank(decision.confirmedWith);
      if (decision.itemIds.length === 0 && !confirmed) {
        add({
          problem: "continue_not_in_sources",
          entryId,
          message:
            "No source lists this medicine. Link the line that does, or say how continuing it was confirmed and which prescriber or clinician confirmed it.",
        });
      } else if (decision.itemIds.length > 0 && !linked.some(showsCurrent) && !confirmed) {
        add({
          problem: "continue_not_shown_current",
          entryId,
          message:
            rec.trigger === "return_from_hospital" && hasLetter
              ? "Only the discharge letter shows what is prescribed after this stay. Link its line, or say how continuing it was confirmed and which prescriber or clinician confirmed it."
              : "Labels, the previous MAR and what the person or family say do not show what is prescribed now. Link a prescription, letter or record, or say how continuing it was confirmed and which prescriber or clinician confirmed it.",
        });
      } else if (linked.some((i) => linkDifference(entry, i) !== null) && blank(decision.note)) {
        add({
          problem: "continue_with_difference",
          entryId,
          message:
            "A linked source shows another product or brand, or is not coded. Say why the MAR entry continues unchanged, or record a change.",
        });
      } else plan.continued.push(entryId);
    } else if (decision.kind === "change") {
      const first = linked[0];
      if (!first) {
        add({
          problem: "change_needs_source_item",
          entryId,
          message: "Link the source line that shows the change.",
        });
        continue;
      }
      const draft = draftFor(decision.draft, sources.get(first.sourceId), { entryId });
      const reanchorReason = blank(decision.reanchorReason)
        ? null
        : (decision.reanchorReason as string);
      if (draft) plan.changes.push({ entryId, draft, reanchorReason });
    } else {
      const lineSources = linked.map((i) => sources.get(i.sourceId)).filter((x) => x !== undefined);
      const document = lineSources.find((x) => asMarSource(x) !== null);
      const marSource = document ? asMarSource(document) : null;
      if (linked.length === 0) {
        add({
          problem: "stop_needs_source_item",
          entryId,
          message:
            "Link the line that says the medicine stops: a letter's line or the prescriber's instruction. A medicine missing from a source is a question, not a stop.",
        });
      } else if (lineSources.length === 0) {
        add({
          problem: "unknown_source",
          entryId,
          message: "The linked line's source is missing.",
        });
      } else if (!marSource) {
        add({ problem: "source_not_a_document", entryId, message: NOT_A_DOCUMENT });
      } else if (blank(decision.reason)) {
        add({
          problem: "stop_needs_reason",
          entryId,
          message: "Say why the medicine stops, as the source says.",
        });
      } else plan.stops.push({ entryId, reason: decision.reason, source: marSource });
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
    } else {
      const draft = draftFor(decision.draft, sources.get(item.sourceId), { itemId });
      if (draft) plan.starts.push({ itemId, draft });
    }
  }

  // The same dm+d product twice on the MAR after the plan: flagged by identity (VMP), never by
  // ingredient; a start beside an entry of the same VMP needs a note (a regular and a
  // when-required entry of one product is common).
  const resulting = [
    ...plan.continued.map((id) => ({ ref: id, vmpId: entries.get(id)?.product.vmpId })),
    ...plan.changes.map((c) => ({ ref: c.entryId, vmpId: c.draft.product.vmpId })),
    ...plan.starts.map((st) => ({ ref: st.itemId, vmpId: st.draft.product.vmpId })),
  ];
  for (const start of plan.starts) {
    const decision = input.itemDecisions.find(
      (d) => d.kind === "start" && d.itemId === start.itemId,
    );
    const note = decision?.kind === "start" ? decision.note : null;
    const twin = resulting.some(
      (r) => r.ref !== start.itemId && r.vmpId === start.draft.product.vmpId,
    );
    if (twin && blank(note)) {
      add({
        problem: "possible_duplicate",
        itemId: start.itemId,
        message: `${start.draft.product.name} is already on the MAR after this reconciliation. Say why a second entry is needed, or link the line to the existing entry.`,
      });
    }
  }

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

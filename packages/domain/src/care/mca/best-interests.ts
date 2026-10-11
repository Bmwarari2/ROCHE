/**
 * Best-interests decisions (care.md section 4 rule 10; CARE-021; master prompt 10.4). The checklist
 * is section 4 of the Mental Capacity Act 2005 with the less restrictive option from s.1(6)
 * (legislation.gov.uk, read 11 October 2026). The checklist is complete only when every item is
 * answered, and "not applicable" counts only with a reason. At least one consultation is recorded
 * or its absence explained (s.4(7)). Where nobody appropriate can be consulted about serious medical
 * treatment or a change of accommodation, the NHS body or local authority must instruct an
 * independent mental capacity advocate (IMCA) (s.37 to s.39); Harbour prompts staff to ask for one.
 */

import { type Citation, cite, SOURCES } from "../../shared/citation";
import { type InputIssue, isIsoDate } from "../assessment";
import type { CapacityOutcome } from "./capacity";

export interface BestInterestsItem {
  readonly key: BestInterestsItemKey;
  readonly provision: string;
  /** The Act's words, shortened only where marked with an ellipsis. */
  readonly wording: string;
  readonly source: Citation;
}

const S4 = (provision: string) => cite("Mental Capacity Act 2005", provision, SOURCES.mcaS4);

export const BEST_INTERESTS_ITEM_KEYS = [
  "no_unjustified_assumptions",
  "relevant_circumstances",
  "regaining_capacity",
  "participation",
  "life_sustaining_treatment",
  "wishes_and_feelings",
  "beliefs_and_values",
  "other_factors",
  "views_of_others",
  "less_restrictive_option",
] as const;
export type BestInterestsItemKey = (typeof BEST_INTERESTS_ITEM_KEYS)[number];

export const BEST_INTERESTS_CHECKLIST: readonly BestInterestsItem[] = [
  {
    key: "no_unjustified_assumptions",
    provision: "s.4(1)",
    wording:
      "Not made merely on the basis of the person's age or appearance, or a condition of his, or an aspect of his behaviour, which might lead others to make unjustified assumptions about what might be in his best interests",
    source: S4("s.4(1)"),
  },
  {
    key: "relevant_circumstances",
    provision: "s.4(2)",
    wording: "Consider all the relevant circumstances",
    source: S4("s.4(2)"),
  },
  {
    key: "regaining_capacity",
    provision: "s.4(3)",
    wording:
      "Whether it is likely that the person will at some time have capacity in relation to the matter in question, and if it appears likely that he will, when that is likely to be",
    source: S4("s.4(3)"),
  },
  {
    key: "participation",
    provision: "s.4(4)",
    wording:
      "So far as reasonably practicable, permit and encourage the person to participate, or to improve his ability to participate, as fully as possible in any act done for him and any decision affecting him",
    source: S4("s.4(4)"),
  },
  {
    key: "life_sustaining_treatment",
    provision: "s.4(5)",
    wording:
      "Where the determination relates to life-sustaining treatment, not be motivated by a desire to bring about his death",
    source: S4("s.4(5)"),
  },
  {
    key: "wishes_and_feelings",
    provision: "s.4(6)(a)",
    wording:
      "The person's past and present wishes and feelings (and, in particular, any relevant written statement made by him when he had capacity)",
    source: S4("s.4(6)(a)"),
  },
  {
    key: "beliefs_and_values",
    provision: "s.4(6)(b)",
    wording:
      "The beliefs and values that would be likely to influence his decision if he had capacity",
    source: S4("s.4(6)(b)"),
  },
  {
    key: "other_factors",
    provision: "s.4(6)(c)",
    wording: "The other factors that he would be likely to consider if he were able to do so",
    source: S4("s.4(6)(c)"),
  },
  {
    key: "views_of_others",
    provision: "s.4(7)",
    wording:
      "If it is practicable and appropriate to consult them, the views of anyone named by the person, anyone engaged in caring for the person or interested in his welfare, any donee of a lasting power of attorney and any deputy appointed by the court",
    source: S4("s.4(7)"),
  },
  {
    key: "less_restrictive_option",
    provision: "s.1(6)",
    wording:
      "Whether the purpose for which it is needed can be as effectively achieved in a way that is less restrictive of the person's rights and freedom of action",
    source: cite("Mental Capacity Act 2005", "s.1(6)", SOURCES.mcaS1),
  },
];

export type ChecklistAnswer =
  | { readonly answer: "considered"; readonly note: string }
  | { readonly answer: "not_applicable"; readonly reason: string };

/** Who was consulted (s.4(7)(a) to (d), and an IMCA). */
export const CONSULTEE_KINDS = [
  "named_by_person",
  "family_or_friend",
  "lpa_donee",
  "deputy",
  "paid_carer_or_professional",
  "imca",
] as const;
export type ConsulteeKind = (typeof CONSULTEE_KINDS)[number];

export interface Consultation {
  readonly consultee: ConsulteeKind;
  /** Their views, as recorded. */
  readonly views: string;
  readonly consultedAt: Date;
}

export interface BestInterestsInput {
  /** The capacity assessment this decision follows. */
  readonly capacityOutcome: CapacityOutcome | null;
  readonly decision: string;
  readonly checklist: Partial<Record<BestInterestsItemKey, ChecklistAnswer>>;
  readonly consultations: readonly Consultation[];
  /** Why nobody was consulted, when nobody was. */
  readonly noConsultationReason?: string | null;
  /** For the IMCA prompt (s.37). */
  readonly seriousMedicalTreatment: boolean;
  /** Accommodation in, or a move to, a hospital or care home arranged by an NHS body or local authority (s.38, s.39). */
  readonly accommodationChange: boolean;
  /** ISO date. */
  readonly reviewOn: string | null;
}

/** Shortest note, reason or explanation accepted (a few words, never blank). */
export const MIN_BEST_INTERESTS_TEXT = 3;

const hasText = (text: string | null | undefined) =>
  (text?.trim().length ?? 0) >= MIN_BEST_INTERESTS_TEXT;

export interface ImcaPrompt {
  readonly message: string;
  readonly sources: readonly Citation[];
}

/** Consultees whose views count as "a person ... whom it would be appropriate to consult" (s.37(1)(b), s.38(1), s.39(1)). */
const APPROPRIATE_CONSULTEES: readonly ConsulteeKind[] = [
  "named_by_person",
  "family_or_friend",
  "lpa_donee",
  "deputy",
];

/**
 * An IMCA is needed for serious medical treatment (s.37) or accommodation arranged by an NHS body
 * (s.38) or a local authority (s.39) when there is nobody, other than people paid to provide care
 * or treatment, whom it would be appropriate to consult. The duty to instruct lies with the NHS
 * body or local authority, so Harbour prompts staff to ask them.
 */
export function imcaPrompt(
  input: Pick<
    BestInterestsInput,
    "consultations" | "seriousMedicalTreatment" | "accommodationChange"
  >,
): ImcaPrompt | null {
  if (!input.seriousMedicalTreatment && !input.accommodationChange) return null;
  const someoneAppropriate = input.consultations.some(
    (c) => APPROPRIATE_CONSULTEES.includes(c.consultee) && hasText(c.views),
  );
  const imcaInvolved = input.consultations.some((c) => c.consultee === "imca");
  if (someoneAppropriate || imcaInvolved) return null;
  const sources: Citation[] = [];
  const asks: string[] = [];
  if (input.seriousMedicalTreatment) {
    asks.push("serious medical treatment (ask the NHS body providing it)");
    sources.push(cite("Mental Capacity Act 2005", "s.37", SOURCES.mcaS37));
  }
  if (input.accommodationChange) {
    asks.push("a change of accommodation (ask the NHS body or local authority arranging it)");
    sources.push(
      cite("Mental Capacity Act 2005", "s.38", SOURCES.mcaS38),
      cite("Mental Capacity Act 2005", "s.39", SOURCES.mcaS39),
    );
  }
  return {
    message: `Nobody other than paid carers or professionals can be consulted about ${asks.join(" and ")}. An independent mental capacity advocate must be instructed.`,
    sources,
  };
}

export type BestInterestsCheck =
  | { readonly ok: true; readonly imca: ImcaPrompt | null }
  | {
      readonly ok: false;
      readonly issues: readonly InputIssue[];
      readonly message: string;
      readonly imca: ImcaPrompt | null;
    };

/** Completeness of a best-interests decision before it is saved (rule 10). */
export function checkBestInterests(input: BestInterestsInput): BestInterestsCheck {
  const issues: InputIssue[] = [];
  const add = (item: string, problem: InputIssue["problem"], message: string) =>
    issues.push({ item, problem, message });

  if (input.capacityOutcome === null) {
    add("capacityOutcome", "missing", "Link the capacity assessment this decision follows.");
  } else if (input.capacityOutcome !== "lacks_capacity") {
    add(
      "capacityOutcome",
      "not_allowed",
      "A best-interests decision is made only for a person who lacks capacity for the decision. The person decides for themselves.",
    );
  }
  if (!hasText(input.decision)) add("decision", "missing", "Record the decision made.");
  for (const item of BEST_INTERESTS_CHECKLIST) {
    const answer = input.checklist[item.key];
    if (!answer) {
      add(`checklist.${item.key}`, "missing", `Answer ${item.provision}: ${item.wording}.`);
    } else if (answer.answer === "not_applicable" && !hasText(answer.reason)) {
      add(`checklist.${item.key}`, "missing", `Give the reason ${item.provision} does not apply.`);
    } else if (answer.answer === "considered" && !hasText(answer.note)) {
      add(
        `checklist.${item.key}`,
        "missing",
        `Record what was considered under ${item.provision}.`,
      );
    }
  }
  input.consultations.forEach((c, i) => {
    if (!CONSULTEE_KINDS.includes(c.consultee))
      add(`consultations.${i}`, "not_allowed", "Choose who was consulted from the list.");
    if (!hasText(c.views)) add(`consultations.${i}`, "missing", "Record their views.");
  });
  if (input.consultations.length === 0 && !hasText(input.noConsultationReason)) {
    add(
      "consultations",
      "missing",
      "Record at least one consultation, or explain why nobody could be consulted.",
    );
  }
  if (!input.reviewOn) add("reviewOn", "missing", "Set a review date.");
  else if (!isIsoDate(input.reviewOn))
    add("reviewOn", "not_allowed", "The review date must be a real date.");

  const imca = imcaPrompt(input);
  if (issues.length === 0) return { ok: true, imca };
  const missing = issues.filter((i) => i.problem === "missing").length;
  return {
    ok: false,
    issues,
    imca,
    message:
      missing > 0
        ? `Best-interests checklist incomplete: ${missing} ${missing === 1 ? "item" : "items"} missing.`
        : "Best-interests decision not saved: check the answers.",
  };
}

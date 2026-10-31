import type {
  AdmissionDecisionItem,
  BedBoard,
  BedOccupancyItem,
  KeyIssueOut,
  PersonStatus,
  PreAdmissionSection,
  PreAdmissionView,
  PropertyItemOut,
  WelcomeChecklist,
} from "@harbour/contracts";
import {
  isValuable,
  MIN_ADMISSION_DECISION_REASON_LENGTH,
  MIN_PRE_ADMISSION_REASON_LENGTH,
  PROPERTY_CATEGORIES,
  personStatusAllows,
  TRAVELS_WITH_PERSON_CATEGORIES,
} from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import { type ActionResult, problemMessage } from "./outcome";

/**
 * Helpers for the pre-admission, admission and property screens (people.md rules 1 and 4 to 7;
 * PEOP-005 and PEOP-007). Pure and unit tested. They only arrange what the API returns and mirror
 * the rules the API applies again (who may do what, what a form must hold before it is sent);
 * nothing is scored or decided here.
 */

// ------------------------------------------------------------------------------------------------
// Permissions (people.md section 3)
// ------------------------------------------------------------------------------------------------

export const ENQUIRY_MANAGE = "people.enquiry.manage";
export const ADMISSION_MANAGE = "people.admission.manage";
export const PROPERTY_MANAGE = "people.property.manage";
export const CARE_PLAN_WRITE = "care.plan.write";
export const PERSON_READ = "people.person.read";

/** Who works with enquiries and pre-admission assessments: the list is offered to them. */
export function preAdmissionShown(permissions: readonly string[]): boolean {
  return (
    permissions.includes(PERSON_READ) &&
    [ENQUIRY_MANAGE, ADMISSION_MANAGE, CARE_PLAN_WRITE].some((p) => permissions.includes(p))
  );
}

/** Pre-admission sections are written by nurses and managers (people.md section 3). */
export const ASSESSMENT_WRITERS = [CARE_PLAN_WRITE, ADMISSION_MANAGE] as const;

/** The welcome checklist is ticked by managers and nurses. */
export const CHECKLIST_WRITERS = [ADMISSION_MANAGE, CARE_PLAN_WRITE] as const;

// ------------------------------------------------------------------------------------------------
// Statuses (rule 1)
// ------------------------------------------------------------------------------------------------

/** People not yet admitted: listed under enquiries and pre-admission, not with the residents. */
export const PRE_ADMISSION_STAGE: readonly PersonStatus[] = [
  "enquiry",
  "pre_admission",
  "not_admitted",
];

/** The API's words for an enquiry id already used for another record (a 422 "invalid"). */
export const ID_IN_USE_DETAIL = "That id is already used.";

/**
 * A refused enquiry in words. The same id sent with other details is refused, never answered with
 * the first record (HZ-001): the form must start a new id and the person check the list first.
 * An id in use for another record is said in the same words, so the form starts a new id too.
 */
export function enquiryRefusal(error: unknown, t: Translator): ActionResult<never> {
  const problem = (typeof error === "object" && error !== null ? error : {}) as {
    readonly code?: unknown;
    readonly detail?: unknown;
  };
  if (
    problem.code === "id_reused_with_different_details" ||
    (problem.code === "invalid" && problem.detail === ID_IN_USE_DETAIL)
  ) {
    return { ok: false, code: "id_reused", message: t("people.enquiry.form.reusedId") };
  }
  return { ok: false, ...problemMessage(error, t) };
}

/** Whether a refusal means the form's id is spent and the next attempt needs a new one. */
export function startsNewEnquiry(result: ActionResult<unknown>): boolean {
  return !result.ok && result.code === "id_reused";
}

export function isPreAdmissionStage(status: PersonStatus): boolean {
  return PRE_ADMISSION_STAGE.includes(status);
}

/** Enquiries and assessments still open come first; closed ones (not admitted) after. */
export function splitPreAdmission<T extends { readonly status: PersonStatus }>(
  people: readonly T[],
): { readonly open: T[]; readonly closed: T[] } {
  return {
    open: people.filter((p) => p.status === "enquiry" || p.status === "pre_admission"),
    closed: people.filter((p) => p.status === "not_admitted"),
  };
}

export type StatusIcon =
  | "inbox"
  | "clipboard-list"
  | "circle-x"
  | "house"
  | "door-open"
  | "hospital"
  | "archive";

/** A person's status as a chip: an icon and a word, never colour alone. */
export function personStatusChip(status: PersonStatus): {
  readonly status: StatusChipStatus;
  readonly icon: StatusIcon;
} {
  switch (status) {
    case "enquiry":
      return { status: "info", icon: "inbox" };
    case "pre_admission":
      return { status: "info", icon: "clipboard-list" };
    case "not_admitted":
      return { status: "neutral", icon: "circle-x" };
    case "active":
      return { status: "done", icon: "house" };
    case "on_leave":
    case "discharged":
      return { status: "neutral", icon: "door-open" };
    case "in_hospital":
      return { status: "neutral", icon: "hospital" };
    default:
      return { status: "neutral", icon: "archive" };
  }
}

// ------------------------------------------------------------------------------------------------
// The pre-admission assessment (rule 4)
// ------------------------------------------------------------------------------------------------

export type SectionState = "complete" | "not_applicable" | "in_progress" | "not_started";

export interface SectionView {
  readonly key: string;
  readonly required: boolean;
  readonly allowNotApplicable: boolean;
  /** Safety facts that are always recorded positively (HZ-007, HZ-015, HZ-016 and others). */
  readonly hazardIds: readonly string[];
  readonly state: SectionState;
  readonly notes: string | null;
  readonly notApplicableReason: string | null;
  readonly medicines: PreAdmissionSection["medicines"];
  readonly completedBy: string | null;
  readonly completedAt: string | null;
  /** The API's problem with this section, when it holds the assessment back. */
  readonly problem: string | null;
}

/** Each section in the order the API defines them, with what has been recorded. */
export function assessmentSections(view: PreAdmissionView): SectionView[] {
  const assessment = view.assessment;
  const problems = new Map(
    (assessment?.completeness.outstanding ?? []).map((o) => [o.key, o.problem]),
  );
  return view.definitions.map((definition) => {
    const section = assessment?.sections[definition.key];
    const state: SectionState = !section
      ? "not_started"
      : section.status === "complete" && section.completedAt
        ? "complete"
        : section.status === "not_applicable" && section.completedAt
          ? "not_applicable"
          : "in_progress";
    return {
      key: definition.key,
      required: definition.required,
      allowNotApplicable: definition.allowNotApplicable,
      hazardIds: definition.hazardIds,
      state,
      notes: section?.notes ?? null,
      notApplicableReason: section?.notApplicableReason ?? null,
      medicines: section?.medicines ?? null,
      completedBy: section?.completedBy ?? null,
      completedAt: section?.completedAt ?? null,
      problem: problems.get(definition.key) ?? null,
    };
  });
}

/** A section's state as a chip. "Not started" on a required section is never calm. */
export function sectionChip(section: Pick<SectionView, "state" | "required">): StatusChipStatus {
  switch (section.state) {
    case "complete":
      return "done";
    case "not_applicable":
      return "notApplicable";
    case "in_progress":
      return "due";
    case "not_started":
      return section.required ? "notRecorded" : "neutral";
  }
}

/** How far the assessment has got: required sections done out of all required. */
export function assessmentProgress(sections: readonly SectionView[]): {
  readonly done: number;
  readonly required: number;
} {
  const required = sections.filter((s) => s.required);
  return {
    done: required.filter((s) => s.state !== "in_progress" && s.state !== "not_started").length,
    required: required.length,
  };
}

export const SECTION_NOTES_MAX = 4000;
export const NOT_APPLICABLE_REASON_MAX = 500;
export const MAX_MEDICINES = 60;
export const MIN_REASON = MIN_PRE_ADMISSION_REASON_LENGTH;

export interface MedicineRow {
  readonly name: string;
  readonly dose: string;
  readonly route: string;
  readonly frequency: string;
  readonly timeCritical: boolean;
}

/**
 * The medicines rows typed into the form: blank rows are dropped; a row with some parts missing
 * is reported by its number (1-based), so the form can say which row to finish.
 */
export function readMedicineRows(rows: readonly MedicineRow[]): {
  readonly medicines: MedicineRow[];
  readonly incomplete: number[];
} {
  const medicines: MedicineRow[] = [];
  const incomplete: number[] = [];
  rows.forEach((row, index) => {
    const parts = [row.name, row.dose, row.route, row.frequency].map((p) => p.trim());
    if (parts.every((p) => p === "")) return;
    if (parts.some((p) => p === "")) {
      incomplete.push(index + 1);
      return;
    }
    const [name = "", dose = "", route = "", frequency = ""] = parts;
    medicines.push({ name, dose, route, frequency, timeCritical: row.timeCritical });
  });
  return { medicines, incomplete };
}

// ------------------------------------------------------------------------------------------------
// The decision to admit (rule 5)
// ------------------------------------------------------------------------------------------------

export const MIN_DECISION_REASONS = MIN_ADMISSION_DECISION_REASON_LENGTH;
export const MAX_CONDITIONS = 20;
export const CONDITION_MAX = 500;

/** "Can meet needs" as a chip. */
export function decisionChip(canMeetNeeds: AdmissionDecisionItem["canMeetNeeds"]): {
  readonly status: StatusChipStatus;
  readonly icon: "circle-check" | "list-checks" | "circle-x";
} {
  switch (canMeetNeeds) {
    case "yes":
      return { status: "done", icon: "circle-check" };
    case "yes_with_conditions":
      return { status: "due", icon: "list-checks" };
    case "no":
      return { status: "neutral", icon: "circle-x" };
  }
}

/** The decision in force (the latest not replaced), and the rest newest first. */
export function currentDecision(items: readonly AdmissionDecisionItem[]): {
  readonly current: AdmissionDecisionItem | null;
  readonly earlier: AdmissionDecisionItem[];
} {
  const sorted = [...items].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  const current = sorted.find((d) => !d.superseded) ?? null;
  return { current, earlier: sorted.filter((d) => d !== current) };
}

/**
 * Whether the person can be admitted on the decision recorded (checkAdmissionReadiness, before a
 * bed is chosen): a positive decision with every condition confirmed met.
 */
export function admissionReadiness(decision: AdmissionDecisionItem | null):
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly reason: "no_decision" | "decision_declined" | "conditions_not_met";
    } {
  if (!decision) return { ready: false, reason: "no_decision" };
  if (!decision.admit) return { ready: false, reason: "decision_declined" };
  if (decision.conditions.some((c) => c.metAt === null)) {
    return { ready: false, reason: "conditions_not_met" };
  }
  return { ready: true };
}

/** The conditions typed in, trimmed, with blank ones dropped. */
export function readConditions(values: readonly string[]): string[] {
  return values.map((v) => v.trim()).filter((v) => v !== "");
}

// ------------------------------------------------------------------------------------------------
// Rooms, beds and moves (rule 6)
// ------------------------------------------------------------------------------------------------

export interface BedChoice {
  /** `roomId:bed`, the value of the select. */
  readonly value: string;
  readonly roomId: string;
  readonly bed: number;
  readonly roomLabel: string;
  /** More than one bed in the room: the label says which. */
  readonly shared: boolean;
}

export interface BedChoiceGroup {
  /** The unit's name, or null for rooms in no unit. */
  readonly unit: string | null;
  readonly beds: BedChoice[];
}

/**
 * The free beds of available rooms on the board's date, grouped by unit in the board's order.
 * The bed the person is in is never offered (a move to the same bed is refused).
 */
export function freeBeds(board: BedBoard, personId?: string): BedChoiceGroup[] {
  const groups: BedChoiceGroup[] = [];
  for (const room of board.rooms) {
    if (room.status !== "available") continue;
    const beds = room.beds
      .filter((b) => !b.occupied && b.personId !== personId)
      .map((b) => ({
        value: `${room.roomId}:${b.bed}`,
        roomId: room.roomId,
        bed: b.bed,
        roomLabel: room.label,
        shared: room.beds.length > 1,
      }));
    if (beds.length === 0) continue;
    let group = groups.find((g) => g.unit === room.unitName);
    if (!group) {
      group = { unit: room.unitName, beds: [] };
      groups.push(group);
    }
    group.beds.push(...beds);
  }
  return groups;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The room and bed chosen in a bed select, or null when the value is not one. */
export function readBedChoice(
  value: unknown,
): { readonly roomId: string; readonly bed: number } | null {
  if (typeof value !== "string") return null;
  const [roomId, bed, ...rest] = value.split(":");
  const number = Number(bed);
  if (rest.length > 0 || !roomId || !UUID.test(roomId) || !Number.isInteger(number)) return null;
  if (number < 1 || number > 20) return null;
  return { roomId, bed: number };
}

export interface MoveView {
  readonly item: BedOccupancyItem;
  readonly current: boolean;
}

/** The bed history newest first, the open period marked as current. */
export function moveHistoryView(items: readonly BedOccupancyItem[]): MoveView[] {
  return [...items]
    .sort((a, b) =>
      a.from === b.from ? b.recordedAt.localeCompare(a.recordedAt) : b.from.localeCompare(a.from),
    )
    .map((item) => ({ item, current: item.to === null }));
}

/** Statuses that keep a bed and allow a room move (rule 1: active and on leave). */
export function mayMoveRoom(status: PersonStatus): boolean {
  return personStatusAllows(status, "room_moves");
}

/** The welcome checklist is part of the care plan: ticked while the person is receiving care. */
export function mayTickChecklist(status: PersonStatus): boolean {
  return personStatusAllows(status, "care_plan_changes");
}

// ------------------------------------------------------------------------------------------------
// The welcome checklist
// ------------------------------------------------------------------------------------------------

export type ChecklistEntry = WelcomeChecklist["items"][number];

/** The items in the order the API keeps them, safety-critical ones first. */
export function checklistItems(checklist: WelcomeChecklist): ChecklistEntry[] {
  return [
    ...checklist.items.filter((i) => i.safetyCritical),
    ...checklist.items.filter((i) => !i.safetyCritical),
  ];
}

export function checklistChip(item: Pick<ChecklistEntry, "status" | "required">): StatusChipStatus {
  if (item.status === "done") return "done";
  if (item.status === "not_applicable") return "notApplicable";
  return item.required ? "due" : "neutral";
}

/** Required items done (or not applicable with a reason) out of all required. */
export function checklistProgress(checklist: WelcomeChecklist): {
  readonly done: number;
  readonly required: number;
} {
  const required = checklist.items.filter((i) => i.required).length;
  return { done: required - checklist.outstanding.length, required };
}

// ------------------------------------------------------------------------------------------------
// Property, valuables and keys (rule 7)
// ------------------------------------------------------------------------------------------------

export const PROPERTY_CATEGORY_OPTIONS = PROPERTY_CATEGORIES;
export type PropertyCategoryOption = (typeof PROPERTY_CATEGORIES)[number];
export const PROPERTY_DESCRIPTION_MAX = 500;
export const MIN_PROPERTY_DESCRIPTION = 3;
export const MAX_QUANTITY = 10000;

export type Signer = "person" | "representative" | "unable_to_sign";

/**
 * Whether a second member of staff must witness: valuables (jewellery, watches, electronics,
 * documents, or anything marked valuable) and anything nobody could sign for (rule 7).
 */
export function needsWitness(input: {
  readonly category: string;
  readonly valuable: boolean;
  readonly signer: Signer | null;
}): boolean {
  return (
    isValuable({ category: input.category, valuable: input.valuable }) ||
    input.signer === "unable_to_sign"
  );
}

/** Whether the category is always a valuable (the box is ticked and cannot be cleared). */
export function valuableCategory(category: string): boolean {
  return isValuable({ category, valuable: false });
}

/** Glasses, hearing aids, dentures and walking aids: offered for the hospital transfer pack. */
export function travelsWithPerson(category: string): boolean {
  return (TRAVELS_WITH_PERSON_CATEGORIES as readonly string[]).includes(category);
}

/** Who property may be returned to: after a death, only the personal representative. */
export function returnCapacities(
  status: PersonStatus,
): readonly ("person" | "representative" | "personal_representative" | "receiving_provider")[] {
  if (status === "deceased") return ["personal_representative"];
  return ["person", "representative", "personal_representative", "receiving_provider"];
}

/** Items and keys come in while the person is receiving care (rule 1). */
export function mayRecordPropertyIn(status: PersonStatus): boolean {
  return personStatusAllows(status, "property_in");
}

/** Items and keys go back while the person is here and after they leave or die (rules 1 and 3). */
export function mayRecordPropertyOut(status: PersonStatus): boolean {
  return personStatusAllows(status, "property_return");
}

/** Each item leaves once: only held items, or items away with the person, can be closed. */
export function propertyOpen(item: Pick<PropertyItemOut, "status">): boolean {
  return item.status === "held" || item.status === "sent_with_person";
}

export function propertyChip(status: PropertyItemOut["status"]): {
  readonly status: StatusChipStatus;
  readonly icon: "package" | "luggage" | "undo-2" | "trash-2" | "circle-help";
} {
  switch (status) {
    case "held":
      return { status: "info", icon: "package" };
    case "sent_with_person":
      return { status: "info", icon: "luggage" };
    case "returned":
      return { status: "done", icon: "undo-2" };
    case "disposed":
      return { status: "neutral", icon: "trash-2" };
    case "lost":
      return { status: "overdue", icon: "circle-help" };
  }
}

/** Items still held or away first (they keep an exit open), then the rest, newest first. */
export function propertyView(items: readonly PropertyItemOut[]): {
  readonly open: PropertyItemOut[];
  readonly closed: PropertyItemOut[];
} {
  const byNewest = [...items].sort((a, b) =>
    a.receivedOn === b.receivedOn
      ? b.id.localeCompare(a.id)
      : b.receivedOn.localeCompare(a.receivedOn),
  );
  return { open: byNewest.filter(propertyOpen), closed: byNewest.filter((i) => !propertyOpen(i)) };
}

export function keyChip(key: Pick<KeyIssueOut, "returnedOn" | "reportedLostOn">): {
  readonly status: StatusChipStatus;
  readonly state: "out" | "returned" | "lost";
} {
  if (key.returnedOn) return { status: "done", state: "returned" };
  if (key.reportedLostOn) return { status: "overdue", state: "lost" };
  return { status: "info", state: "out" };
}

/** Keys still out first (they block an exit), then the rest, newest first. */
export function keysView(items: readonly KeyIssueOut[]): KeyIssueOut[] {
  return [...items].sort((a, b) =>
    a.outstanding !== b.outstanding
      ? a.outstanding
        ? -1
        : 1
      : b.issuedOn.localeCompare(a.issuedOn),
  );
}

/** A whole number from 1 to the maximum, from what was typed; null otherwise. */
export function readQuantity(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const number = Number(text);
  return number >= 1 && number <= MAX_QUANTITY ? number : null;
}

/** "You" or "a colleague": staff are named by opaque id only in these records. */
export function whoDid(by: string | null, me: string): "you" | "colleague" | "unknown" {
  if (!by) return "unknown";
  return by === me ? "you" : "colleague";
}

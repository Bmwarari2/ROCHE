import type { AdvanceCareRecordState } from "../care/advance-care";
import { PCSP_DOMAIN_LABELS, PCSP_DOMAINS, type PcspDomain } from "../care/care-plan";
import { describeIddsiLevel, iddsiLevel } from "../care/iddsi";
import type { RiskBand } from "../care/risk-assessment";
import { LIVE_PERSON_STATUSES, type PersonStatus } from "../people/lifecycle";
import type {
  AllergyStatement,
  CommunicationStatement,
  SectionSource,
  TransferAllergy,
} from "../people/transfer-pack";
import {
  formatUkDateTime,
  isUkClockChangeDay,
  toUkWallClock,
  ukZoneAbbreviation,
} from "../shared/time";
import type { OperationsRates } from "./rates";

/**
 * Nightly downtime pack (master prompt 13.4, fire safety and PEEPs row: "a nightly downtime pack
 * per location (MAR, care plan summaries, allergies, PEEPs, contacts) printed or cached on the kiosk
 * for power cuts and IT outages"; operations.md section 4 rules 1 to 7; hazard HZ-021).
 *
 * A pure function selects, for one location, a page per person receiving care. It copies what is
 * recorded and never interprets it (medical-device boundary): where resuscitation records disagree
 * it prints every record in force and says so, and never picks one. It never leaves a person out
 * because their record is incomplete: missing safety-critical information reads "not recorded" in
 * words, a value it cannot read says "check the record", a section that belongs to someone else is
 * withheld (HZ-001), and every page says when the information is from and whether it can still be
 * relied on (HZ-021).
 */

export interface DowntimeSectionDefinition {
  readonly key: string;
  readonly title: string;
  /** Safety-critical sections are never blank: they say "not recorded" or where to look instead. */
  readonly critical: boolean;
  readonly hazardIds: readonly string[];
}

export const DOWNTIME_PACK_SECTIONS = [
  {
    key: "identity",
    title: "Name, photo and room",
    critical: true,
    hazardIds: ["HZ-001", "HZ-021"],
  },
  {
    key: "allergies",
    title: "Allergies and adverse reactions",
    critical: true,
    hazardIds: ["HZ-007", "HZ-021"],
  },
  {
    key: "resuscitation",
    title: "Resuscitation status",
    critical: true,
    hazardIds: ["HZ-015", "HZ-021"],
  },
  {
    key: "iddsi_food",
    title: "Food texture (IDDSI level)",
    critical: true,
    hazardIds: ["HZ-016", "HZ-021"],
  },
  {
    key: "iddsi_drink",
    title: "Drink thickness (IDDSI level)",
    critical: true,
    hazardIds: ["HZ-016", "HZ-021"],
  },
  { key: "communication", title: "Communication needs", critical: true, hazardIds: ["HZ-021"] },
  {
    key: "evacuation",
    title: "Personal emergency evacuation plan (PEEP)",
    critical: true,
    hazardIds: ["HZ-021"],
  },
  {
    key: "medicines_due",
    title: "Medicines due while this pack is in use",
    critical: true,
    hazardIds: ["HZ-003", "HZ-021"],
  },
  { key: "contacts", title: "Key contacts", critical: false, hazardIds: [] },
  { key: "care_plan", title: "Care plan summary by need", critical: false, hazardIds: ["HZ-024"] },
  { key: "risks", title: "Active risks", critical: false, hazardIds: [] },
] as const satisfies readonly DowntimeSectionDefinition[];

export type DowntimeSectionKey = (typeof DOWNTIME_PACK_SECTIONS)[number]["key"];

// ------------------------------------------------------------------------------------------------
// Ports: PEEPs (operations, Phase 3 facilities) and medicines (eMAR, Phase 2)
// ------------------------------------------------------------------------------------------------

/** A PEEP from the fire safety module, or where staff find it until that module exists. */
export type EvacuationPlanStatement =
  | { readonly status: "held_elsewhere"; readonly where: string }
  | {
      readonly status: "recorded";
      readonly summary: string;
      readonly equipment: readonly string[];
      readonly staffNeeded: number | null;
    };

/** A scheduled dose from the eMAR (Phase 2), with whether it has already been given. */
export interface ScheduledDose {
  readonly name: string;
  readonly dose: string;
  readonly route: string;
  readonly dueAt: Date;
  /** Time-critical medicines (for example for Parkinson's disease) are listed first at each time. */
  readonly timeCritical: boolean;
  /** Only `due` doses are listed; a dose already given, or recorded as not given, is not due. */
  readonly status: "due" | "given" | "not_given";
  readonly givenAt: Date | null;
}

/** A when-required medicine, listed with when it was last given so nobody repeats it too soon. */
export interface PrnMedicine {
  readonly name: string;
  readonly dose: string;
  readonly route: string;
  readonly reason: string | null;
  readonly lastGivenAt: Date | null;
}

/** Medicines from the eMAR, or where staff find them until then. */
export type MedicinesDueStatement =
  | { readonly status: "held_elsewhere"; readonly where: string }
  | {
      readonly status: "recorded";
      readonly scheduled: readonly ScheduledDose[];
      readonly prn: readonly PrnMedicine[];
    };

/** Implemented by the medicines module in Phase 2; the API calls it once per person. */
export interface DowntimeMedicinesPort {
  readonly provider: string;
  /** Doses scheduled for a person from `from` (inclusive) to `until` (exclusive), and their PRNs. */
  medicinesDue(personId: string, from: Date, until: Date): Promise<MedicinesDueStatement>;
}

/** Implemented by the fire safety and PEEPs feature (OPS rows, Phase 3). */
export interface DowntimeEvacuationPort {
  readonly provider: string;
  evacuationPlan(personId: string): Promise<EvacuationPlanStatement>;
}

/** Seeded into each location's settings; the Registered Manager changes it to the real place. */
export const DEFAULT_PAPER_MAR_LOCATION = "the paper MAR chart";
export const DEFAULT_PEEP_LOCATION = "the person's PEEP in the fire file";

function where(text: string, missing: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new RangeError(missing);
  return trimmed;
}

/**
 * Phase 1: medicines are on paper, so the pack says where to look. The wording is the location's
 * setting (for example "the MAR folder in the clinical room"), not a fixed phrase.
 */
export function paperMarMedicinesPort(location: string): DowntimeMedicinesPort {
  const place = where(location, "Set where the paper MAR is kept for this location.");
  return {
    provider: "paper_mar",
    medicinesDue: async () => ({ status: "held_elsewhere", where: place }),
  };
}

/** Until PEEPs are kept in Harbour, the pack points to where the location keeps them. */
export function fireFileEvacuationPort(location: string): DowntimeEvacuationPort {
  const place = where(location, "Set where the PEEPs are kept for this location.");
  return {
    provider: "fire_file",
    evacuationPlan: async () => ({ status: "held_elsewhere", where: place }),
  };
}

// ------------------------------------------------------------------------------------------------
// Input
// ------------------------------------------------------------------------------------------------

export interface DowntimeContact {
  /** The person the contact belongs to (a contact of someone else is withheld, HZ-001). */
  readonly personId: string;
  readonly name: string;
  readonly relationship: string | null;
  readonly role: string;
  readonly phone: string | null;
}

export interface DowntimeCarePlanSection {
  readonly domain: PcspDomain;
  readonly need: string;
  readonly contingency: string | null;
}

/** The active (published) care plan only; drafts never print (HZ-024). */
export interface DowntimeCarePlan {
  readonly publishedVersion: number;
  readonly sections: readonly DowntimeCarePlanSection[];
}

export interface DowntimeRisk {
  readonly title: string;
  readonly hazard: string;
  readonly controls: string;
  readonly band: RiskBand | null;
  readonly reviewDueOn: string | null;
}

/** The stored codes, checked here: a code that is not an IDDSI level prints "check the record". */
export interface DowntimeEatingAndDrinking {
  readonly foodLevel: string | null;
  readonly drinkLevel: string | null;
  readonly notes: string | null;
}

export interface DowntimePersonInput {
  readonly personId: string;
  readonly locationId: string;
  readonly status: PersonStatus;
  readonly givenName: string;
  readonly familyName: string;
  readonly preferredName: string | null;
  /** yyyy-mm-dd */
  readonly dateOfBirth: string | null;
  readonly nhsNumber: string | null;
  readonly roomLabel: string | null;
  readonly photo: SectionSource<{ readonly documentId: string; readonly takenOn: string }> | null;
  readonly allergies: SectionSource<AllergyStatement>;
  /** The person's advance care records; every active ReSPECT or DNACPR decision prints. */
  readonly resuscitation: SectionSource<readonly AdvanceCareRecordState[]>;
  readonly eatingAndDrinking: SectionSource<DowntimeEatingAndDrinking> | null;
  readonly communication: SectionSource<CommunicationStatement>;
  readonly evacuation: SectionSource<EvacuationPlanStatement>;
  readonly medicinesDue: SectionSource<MedicinesDueStatement>;
  readonly contacts: readonly DowntimeContact[];
  readonly carePlan: SectionSource<DowntimeCarePlan> | null;
  readonly risks: SectionSource<readonly DowntimeRisk[]>;
}

export interface DowntimePackInput {
  readonly packId: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly generatedAt: Date;
  /**
   * When the information was read: the server's read time for the nightly pack, or the device's
   * last sync time for a pack built on a kiosk from its cache. Freshness counts from here.
   */
  readonly asAt: Date;
  readonly people: readonly DowntimePersonInput[];
}

// ------------------------------------------------------------------------------------------------
// Output
// ------------------------------------------------------------------------------------------------

/**
 * `conflicting`: resuscitation records in force disagree (every one prints, none is chosen);
 * `unreadable`: the stored value could not be read, so the page says to check the record.
 */
export type DowntimeSectionState =
  | "included"
  | "not_recorded"
  | "held_elsewhere"
  | "withheld"
  | "conflicting"
  | "unreadable";

export interface DowntimeSectionStatus {
  readonly key: DowntimeSectionKey;
  readonly title: string;
  readonly critical: boolean;
  readonly hazardIds: readonly string[];
  readonly status: DowntimeSectionState;
  readonly asOf: Date | null;
  /** The words printed inside the section, in place of or beside its content. */
  readonly note: string | null;
}

export type DowntimeWarningKind =
  | "critical_not_recorded"
  | "resuscitation_conflict"
  | "unreadable_value"
  | "resuscitation_review_overdue"
  | "section_withheld"
  | "date_of_birth_not_recorded";

export interface DowntimeWarning {
  readonly personId: string;
  readonly kind: DowntimeWarningKind;
  readonly section: DowntimeSectionKey | null;
  readonly message: string;
}

export interface DowntimeIddsiContent {
  /** For example "Level 6 Soft and bite-sized (blue)"; null when not recorded or unreadable. */
  readonly food: string | null;
  readonly drink: string | null;
  readonly notes: string | null;
}

export interface DowntimeResuscitationRecord {
  readonly recordId: string;
  readonly kind: "respect" | "dnacpr";
  readonly decision: "attempt_cpr" | "do_not_attempt_cpr";
  readonly completedOn: string;
  readonly clinicianName: string | null;
  readonly clinicianRole: string | null;
  readonly reviewDueOn: string | null;
  readonly reviewOverdue: boolean;
}

export interface DowntimeCarePlanLine {
  readonly domain: PcspDomain;
  readonly label: string;
  readonly need: string;
  readonly contingency: string | null;
}

export type DowntimeMedicinesContent =
  | { readonly status: "held_elsewhere"; readonly where: string }
  | {
      readonly status: "recorded";
      /** Doses still due while the pack is in use, in time order, time-critical first. */
      readonly due: readonly ScheduledDose[];
      readonly prn: readonly PrnMedicine[];
    };

export interface DowntimePersonPage {
  readonly personId: string;
  /** "Example, Ada (Addie)": family name first, so the printed pack reads like a register. */
  readonly displayName: string;
  readonly dateOfBirth: string | null;
  readonly nhsNumber: string | null;
  readonly roomLabel: string | null;
  readonly status: PersonStatus;
  /** "In hospital" or "On leave" when the person is away from the home, otherwise null. */
  readonly away: string | null;
  readonly sections: readonly DowntimeSectionStatus[];
  readonly content: {
    readonly photo: { readonly documentId: string; readonly takenOn: string } | null;
    readonly allergies: AllergyStatement;
    /** Every ReSPECT and DNACPR decision in force, newest first; empty when none or withheld. */
    readonly resuscitation: readonly DowntimeResuscitationRecord[];
    /**
     * An advance decision to refuse treatment is held in force (HZ-015): printed beside the CPR
     * decision, never as one, and never read as nothing recorded.
     */
    readonly adrtHeld: boolean;
    readonly eatingAndDrinking: DowntimeIddsiContent;
    readonly communication: CommunicationStatement;
    readonly evacuation: EvacuationPlanStatement | null;
    readonly medicinesDue: DowntimeMedicinesContent | null;
    readonly contacts: readonly DowntimeContact[];
    readonly carePlan: readonly DowntimeCarePlanLine[];
    readonly risks: readonly DowntimeRisk[];
  };
  readonly missingCritical: readonly DowntimeSectionKey[];
  readonly warnings: readonly DowntimeWarning[];
}

export type DowntimeExclusionReason = "not_receiving_care" | "other_location";

export interface DowntimePack {
  readonly packId: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly generatedAt: Date;
  readonly asAt: Date;
  /** `asAt` plus `downtime_pack.valid_hours`: after this the pack says it is out of date. */
  readonly validUntil: Date;
  readonly pages: readonly DowntimePersonPage[];
  /** People supplied but not printed, with the reason (never someone receiving care here). */
  readonly excluded: readonly {
    readonly personId: string;
    readonly reason: DowntimeExclusionReason;
  }[];
  /** Every page's warnings, safety-critical ones first, for the front sheet. */
  readonly warnings: readonly DowntimeWarning[];
}

export type DowntimePackProblem = "as_at_after_generation" | "location_name_missing";

export type DowntimePackResult =
  | { readonly ok: true; readonly pack: DowntimePack }
  | { readonly ok: false; readonly problem: DowntimePackProblem; readonly message: string };

const PACK_PROBLEM_MESSAGES: Record<DowntimePackProblem, string> = {
  as_at_after_generation:
    "The information cannot be newer than the pack. Check the device clock and the last sync time.",
  location_name_missing: "The pack needs the location's name on every page.",
};

/** Printed on the front sheet and every page's header (operations.md rule 2). */
export const DOWNTIME_BACK_ENTRY_INSTRUCTION =
  "Write care on the downtime forms with the time you gave it. When Harbour is back, enter each form with that time and the outage it belongs to.";

const NOT_RECORDED_NOTES: Partial<Record<DowntimeSectionKey, string>> = {
  identity: "No photo on record. Confirm who the person is with a colleague who knows them.",
  allergies: "Allergies not recorded. Do not assume there are none.",
  resuscitation:
    "Resuscitation status not recorded. Check the person's documents and follow the home's policy.",
  iddsi_food:
    "IDDSI food level not recorded. Check with the nurse in charge before giving any food.",
  iddsi_drink:
    "IDDSI drink level not recorded. Check with the nurse in charge before giving any drink.",
  communication: "Communication needs not recorded. Ask the person or their family.",
  contacts: "No key contacts recorded.",
  care_plan: "No active care plan. Follow the paper care plan if there is one.",
  risks: "No active risk assessments recorded.",
};

/** Printed in the resuscitation section whenever an ADRT is held (HZ-015; wording H-100). */
export const ADRT_HELD_NOTE = "ADRT also held: read it before any decision about resuscitation.";

/** With an ADRT and no CPR decision: never "not recorded" (#46 review round 1, clinical M4). */
export const ADRT_ONLY_NOTE = `No ReSPECT or DNACPR decision is held in Harbour. ${ADRT_HELD_NOTE}`;

/** Words for a resuscitation conflict, printed inside the section (to confirm with the CSO, H-100). */
export const RESUSCITATION_CONFLICT_NOTE =
  "Resuscitation records disagree. Every record in force is listed here. Harbour does not choose between them: check the signed forms and follow the home's policy.";

const UNREADABLE_NOTE =
  "This could not be read from the record. Check the record before giving food or drink.";

const WITHHELD_NOTE =
  "Not included: this information did not match the person. Check the record when Harbour is back.";

/** Unknown severity sorts with severe: an unknown reaction is never shown as the mildest. */
const SEVERITY_ORDER: Record<TransferAllergy["severity"], number> = {
  severe: 0,
  unknown: 0,
  moderate: 1,
  mild: 2,
};

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

function hasText(value: string | null | undefined): value is string {
  return (value?.trim().length ?? 0) > 0;
}

function ukDate(instant: Date): string {
  const w = toUkWallClock(instant);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

function displayName(person: DowntimePersonInput): string {
  const preferred =
    hasText(person.preferredName) && person.preferredName.trim() !== person.givenName.trim()
      ? ` (${person.preferredName.trim()})`
      : "";
  return `${person.familyName.trim()}, ${person.givenName.trim()}${preferred}`;
}

function awayLabel(status: PersonStatus): string | null {
  if (status === "in_hospital") return "In hospital";
  if (status === "on_leave") return "On leave";
  return null;
}

function normaliseAllergies(statement: AllergyStatement): AllergyStatement {
  if (statement.status !== "has_allergies") return statement;
  if (statement.allergies.length === 0) return { status: "unknown" };
  return {
    status: "has_allergies",
    allergies: [...statement.allergies].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    ),
  };
}

function normaliseCommunication(statement: CommunicationStatement): CommunicationStatement {
  if (statement.status === "recorded" && statement.needs.length === 0)
    return { status: "not_recorded" };
  return statement;
}

/** Every active ReSPECT or DNACPR decision, newest first. Harbour never picks one. */
function resuscitationInForce(
  records: readonly AdvanceCareRecordState[],
  today: string,
): DowntimeResuscitationRecord[] {
  const inForce: DowntimeResuscitationRecord[] = [];
  for (const r of records) {
    if (r.status !== "active" || r.cprDecision === null) continue;
    if (r.kind !== "respect" && r.kind !== "dnacpr") continue;
    inForce.push({
      recordId: r.id,
      kind: r.kind,
      decision: r.cprDecision,
      completedOn: r.completedOn,
      clinicianName: r.clinicianName,
      clinicianRole: r.clinicianRole,
      reviewDueOn: r.reviewDueOn,
      reviewOverdue: r.reviewDueOn !== null && today > r.reviewDueOn,
    });
  }
  return inForce.sort((a, b) => b.completedOn.localeCompare(a.completedOn));
}

function medicinesInWindow(
  statement: MedicinesDueStatement,
  from: Date,
  until: Date,
): DowntimeMedicinesContent {
  if (statement.status === "held_elsewhere") return statement;
  const due = statement.scheduled
    .filter(
      (d) =>
        d.status === "due" &&
        d.dueAt.getTime() >= from.getTime() &&
        d.dueAt.getTime() < until.getTime(),
    )
    .sort(
      (a, b) =>
        a.dueAt.getTime() - b.dueAt.getTime() || Number(b.timeCritical) - Number(a.timeCritical),
    );
  return { status: "recorded", due, prn: statement.prn };
}

/** One IDDSI level: described, not recorded, or unreadable (never throws for a bad code). */
function iddsiValue(
  kind: "food" | "drink",
  code: string | null,
): { readonly state: DowntimeSectionState; readonly text: string | null } {
  if (code === null || code.trim() === "") return { state: "not_recorded", text: null };
  if (iddsiLevel(kind, code) === null) return { state: "unreadable", text: null };
  return { state: "included", text: describeIddsiLevel(kind, code) };
}

function carePlanLines(plan: DowntimeCarePlan): DowntimeCarePlanLine[] {
  return [...plan.sections]
    .filter((s) => hasText(s.need))
    .sort((a, b) => PCSP_DOMAINS.indexOf(a.domain) - PCSP_DOMAINS.indexOf(b.domain))
    .map((s) => ({
      domain: s.domain,
      label: PCSP_DOMAIN_LABELS[s.domain],
      need: s.need.trim(),
      contingency: hasText(s.contingency) ? s.contingency.trim() : null,
    }));
}

/** One person's page. Sections from another person's record are withheld, never printed. */
function personPage(person: DowntimePersonInput, from: Date, until: Date): DowntimePersonPage {
  const own = (source: { readonly personId: string } | null): boolean =>
    source === null || source.personId === person.personId;
  const warnings: DowntimeWarning[] = [];
  const warn = (kind: DowntimeWarningKind, section: DowntimeSectionKey | null, message: string) =>
    warnings.push({ personId: person.personId, kind, section, message });
  const statuses = new Map<
    DowntimeSectionKey,
    { status: DowntimeSectionState; asOf: Date | null; note: string | null }
  >();
  const set = (
    key: DowntimeSectionKey,
    status: DowntimeSectionState,
    asOf: Date | null,
    note: string | null = null,
  ) => {
    statuses.set(key, { status, asOf, note });
    if (status === "withheld") warn("section_withheld", key, WITHHELD_NOTE);
  };

  // Identity: the name and room always print; the photo is the safety-critical part (HZ-001).
  const photoOwn = own(person.photo);
  set(
    "identity",
    !photoOwn ? "withheld" : person.photo ? "included" : "not_recorded",
    person.photo?.asOf ?? null,
  );

  const allergiesOwn = own(person.allergies);
  const allergies = allergiesOwn
    ? normaliseAllergies(person.allergies.data)
    : ({ status: "unknown" } as const);
  set(
    "allergies",
    !allergiesOwn ? "withheld" : allergies.status === "unknown" ? "not_recorded" : "included",
    person.allergies.asOf,
  );

  // Resuscitation (HZ-015): every decision in force prints; disagreement is a state of its own.
  const resusOwn = own(person.resuscitation);
  const resuscitation = resusOwn
    ? resuscitationInForce(person.resuscitation.data, ukDate(from))
    : [];
  const decisions = new Set(resuscitation.map((r) => r.decision));
  const adrtHeld =
    resusOwn && person.resuscitation.data.some((r) => r.kind === "adrt" && r.status === "active");
  if (!resusOwn) set("resuscitation", "withheld", person.resuscitation.asOf);
  else if (resuscitation.length === 0 && adrtHeld)
    set("resuscitation", "included", person.resuscitation.asOf, ADRT_ONLY_NOTE);
  else if (resuscitation.length === 0)
    set("resuscitation", "not_recorded", person.resuscitation.asOf);
  else if (decisions.size > 1) {
    set("resuscitation", "conflicting", person.resuscitation.asOf, RESUSCITATION_CONFLICT_NOTE);
    warn("resuscitation_conflict", "resuscitation", RESUSCITATION_CONFLICT_NOTE);
  } else set("resuscitation", "included", person.resuscitation.asOf);
  if (resuscitation.some((r) => r.reviewOverdue)) {
    warn(
      "resuscitation_review_overdue",
      "resuscitation",
      "A resuscitation decision is past its review date. It still applies until changed.",
    );
  }

  // IDDSI (HZ-016): food and drink are separate, each recorded, not recorded or unreadable.
  const eatingOwn = own(person.eatingAndDrinking);
  const eatingData = eatingOwn ? (person.eatingAndDrinking?.data ?? null) : null;
  const food = iddsiValue("food", eatingData?.foodLevel ?? null);
  const drink = iddsiValue("drink", eatingData?.drinkLevel ?? null);
  const eatingAsOf = person.eatingAndDrinking?.asOf ?? null;
  for (const [key, value] of [
    ["iddsi_food", food],
    ["iddsi_drink", drink],
  ] as const) {
    if (!eatingOwn) set(key, "withheld", eatingAsOf);
    else if (value.state === "unreadable") {
      set(key, "unreadable", eatingAsOf, UNREADABLE_NOTE);
      warn("unreadable_value", key, UNREADABLE_NOTE);
    } else set(key, value.state, eatingAsOf);
  }

  const communicationOwn = own(person.communication);
  const communication = communicationOwn
    ? normaliseCommunication(person.communication.data)
    : ({ status: "not_recorded" } as const);
  set(
    "communication",
    !communicationOwn
      ? "withheld"
      : communication.status === "not_recorded"
        ? "not_recorded"
        : "included",
    person.communication.asOf,
  );

  const evacuationOwn = own(person.evacuation);
  const evacuation = evacuationOwn ? person.evacuation.data : null;
  if (!evacuation) set("evacuation", "withheld", person.evacuation.asOf);
  else if (evacuation.status === "held_elsewhere")
    set(
      "evacuation",
      "held_elsewhere",
      person.evacuation.asOf,
      `Not kept in Harbour yet. Use ${evacuation.where}.`,
    );
  else set("evacuation", "included", person.evacuation.asOf);

  const medicinesOwn = own(person.medicinesDue);
  const medicinesDue = medicinesOwn
    ? medicinesInWindow(person.medicinesDue.data, from, until)
    : null;
  if (!medicinesDue) set("medicines_due", "withheld", person.medicinesDue.asOf);
  else if (medicinesDue.status === "held_elsewhere")
    set(
      "medicines_due",
      "held_elsewhere",
      person.medicinesDue.asOf,
      `Not kept in Harbour yet. Use ${medicinesDue.where}.`,
    );
  else set("medicines_due", "included", person.medicinesDue.asOf);

  // A contact of someone else is left out and flagged; the person's own contacts still print.
  const contacts = person.contacts.filter((c) => c.personId === person.personId);
  if (contacts.length < person.contacts.length) warn("section_withheld", "contacts", WITHHELD_NOTE);
  set("contacts", contacts.length === 0 ? "not_recorded" : "included", null);

  const planOwn = own(person.carePlan);
  const carePlan = planOwn && person.carePlan ? carePlanLines(person.carePlan.data) : [];
  set(
    "care_plan",
    !planOwn ? "withheld" : carePlan.length === 0 ? "not_recorded" : "included",
    person.carePlan?.asOf ?? null,
  );

  const risksOwn = own(person.risks);
  const risks = risksOwn ? person.risks.data : [];
  set(
    "risks",
    !risksOwn ? "withheld" : risks.length === 0 ? "not_recorded" : "included",
    person.risks.asOf,
  );

  const sections: DowntimeSectionStatus[] = DOWNTIME_PACK_SECTIONS.map((definition) => {
    const state = statuses.get(definition.key) ?? {
      status: "not_recorded" as const,
      asOf: null,
      note: null,
    };
    const note =
      state.note ??
      (state.status === "withheld"
        ? WITHHELD_NOTE
        : state.status === "not_recorded"
          ? (NOT_RECORDED_NOTES[definition.key] ?? null)
          : null);
    return {
      key: definition.key,
      title: definition.title,
      critical: definition.critical,
      hazardIds: definition.hazardIds,
      status: state.status,
      asOf: state.asOf,
      note,
    };
  });

  const missingCritical = sections
    .filter((s) => s.critical && s.status === "not_recorded")
    .map((s) => s.key);
  for (const key of [...missingCritical].reverse()) {
    warnings.unshift({
      personId: person.personId,
      kind: "critical_not_recorded",
      section: key,
      message: NOT_RECORDED_NOTES[key] ?? "Not recorded.",
    });
  }
  if (!person.dateOfBirth) {
    warn(
      "date_of_birth_not_recorded",
      "identity",
      "Date of birth not recorded. Confirm identity another way.",
    );
  }

  return {
    personId: person.personId,
    displayName: displayName(person),
    dateOfBirth: person.dateOfBirth,
    nhsNumber: person.nhsNumber,
    roomLabel: person.roomLabel,
    status: person.status,
    away: awayLabel(person.status),
    sections,
    content: {
      photo: photoOwn ? (person.photo?.data ?? null) : null,
      allergies,
      resuscitation,
      adrtHeld,
      eatingAndDrinking: {
        food: food.text,
        drink: drink.text,
        notes: hasText(eatingData?.notes) ? (eatingData?.notes ?? "").trim() : null,
      },
      communication,
      evacuation,
      medicinesDue,
      contacts,
      carePlan,
      risks,
    },
    missingCritical,
    warnings,
  };
}

function comparePages(a: DowntimePersonPage, b: DowntimePersonPage): number {
  if (a.roomLabel !== b.roomLabel) {
    if (a.roomLabel === null) return 1;
    if (b.roomLabel === null) return -1;
    const byRoom = collator.compare(a.roomLabel, b.roomLabel);
    if (byRoom !== 0) return byRoom;
  }
  return collator.compare(a.displayName, b.displayName);
}

const WARNING_ORDER: Record<DowntimeWarningKind, number> = {
  critical_not_recorded: 0,
  resuscitation_conflict: 0,
  unreadable_value: 1,
  section_withheld: 2,
  date_of_birth_not_recorded: 3,
  resuscitation_review_overdue: 4,
};

/**
 * Selects the downtime pack for one location: a page for every person receiving care there
 * (active, on leave or in hospital, since they may come back during the outage), in room order.
 */
export function assembleDowntimePack(
  input: DowntimePackInput,
  rates: Pick<OperationsRates, "downtimePackValidHours">,
): DowntimePackResult {
  if (input.asAt.getTime() > input.generatedAt.getTime()) {
    return {
      ok: false,
      problem: "as_at_after_generation",
      message: PACK_PROBLEM_MESSAGES.as_at_after_generation,
    };
  }
  if (!hasText(input.locationName)) {
    return {
      ok: false,
      problem: "location_name_missing",
      message: PACK_PROBLEM_MESSAGES.location_name_missing,
    };
  }
  const validUntil = new Date(input.asAt.getTime() + rates.downtimePackValidHours * MS_PER_HOUR);
  const excluded: { personId: string; reason: DowntimeExclusionReason }[] = [];
  const pages: DowntimePersonPage[] = [];
  for (const person of input.people) {
    if (person.locationId !== input.locationId) {
      excluded.push({ personId: person.personId, reason: "other_location" });
    } else if (!LIVE_PERSON_STATUSES.includes(person.status)) {
      excluded.push({ personId: person.personId, reason: "not_receiving_care" });
    } else {
      pages.push(personPage(person, input.asAt, validUntil));
    }
  }
  pages.sort(comparePages);
  const warnings = pages
    .flatMap((p) => p.warnings)
    .sort((a, b) => WARNING_ORDER[a.kind] - WARNING_ORDER[b.kind]);
  return {
    ok: true,
    pack: {
      packId: input.packId,
      locationId: input.locationId,
      locationName: input.locationName.trim(),
      generatedAt: input.generatedAt,
      asAt: input.asAt,
      validUntil,
      pages,
      excluded,
      warnings,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Freshness (HZ-021): words on every page, worked out when the page is shown or printed
// ------------------------------------------------------------------------------------------------

/**
 * `current` and `out_of_date` against the "use until" time; `outage` while an outage is declared
 * at the location (the pack is the latest available and anything since is on paper);
 * `clock_behind` when the showing device's clock is earlier than the pack's information, so the
 * age cannot be trusted.
 */
export type DowntimeFreshnessState = "current" | "out_of_date" | "outage" | "clock_behind";

export interface DowntimeFreshness {
  readonly state: DowntimeFreshnessState;
  readonly notice: string;
  /** Whole hours between the information's time and `at` (never negative). */
  readonly hoursOld: number;
}

export interface DowntimeFreshnessContext {
  /** The outage declared and still open at the location, if any. */
  readonly outage: { readonly startedAt: Date } | null;
  /** `sync.clock_drift_flag_minutes`: a clock behind the pack by more than this is flagged. */
  readonly clockDriftMinutes: number;
}

/**
 * dd/mm/yyyy hh:mm UK time, with BST or GMT on a clock-change day so the two 01:30s in October
 * differ (HZ-009; #46 review round 1), as the transfer pack prints it.
 */
function packTime(instant: Date): string {
  const w = toUkWallClock(instant);
  const time = formatUkDateTime(instant);
  return isUkClockChangeDay(w.year, w.month, w.day)
    ? `${time} ${ukZoneAbbreviation(instant)}`
    : time;
}

/** Whether a pack can still be relied on at `at`, in words for the page (operations.md rule 2). */
export function downtimePackFreshness(
  pack: Pick<DowntimePack, "asAt" | "validUntil">,
  at: Date,
  context: DowntimeFreshnessContext,
): DowntimeFreshness {
  const asAt = packTime(pack.asAt);
  const until = packTime(pack.validUntil);
  const hoursOld = Math.max(0, Math.floor((at.getTime() - pack.asAt.getTime()) / MS_PER_HOUR));
  if (pack.asAt.getTime() - at.getTime() > context.clockDriftMinutes * MS_PER_MINUTE) {
    return {
      state: "clock_behind",
      hoursOld,
      notice: `Check this device's clock: it shows ${packTime(at)}, earlier than this pack's information (${asAt}). Until the clock is right, treat the pack as possibly out of date and check allergies, resuscitation status and diet with the nurse in charge.`,
    };
  }
  if (context.outage !== null) {
    // Paper began when the outage did, so a pack made after it began still misses what is on
    // paper since then (#45 review round 1, clinical M2): the earlier of the two.
    const since = packTime(
      context.outage.startedAt.getTime() < pack.asAt.getTime()
        ? context.outage.startedAt
        : pack.asAt,
    );
    return {
      state: "outage",
      hoursOld,
      notice: `Latest available pack: information as at ${asAt}. Anything recorded since ${since} is on paper or not shown here: check the downtime forms and ask the nurse in charge about changes.`,
    };
  }
  if (at.getTime() < pack.validUntil.getTime()) {
    return {
      state: "current",
      hoursOld,
      notice: `Information as at ${asAt}. Use until ${until}, then use a newer pack.`,
    };
  }
  return {
    state: "out_of_date",
    hoursOld,
    notice: `Out of date: this information is from ${asAt} (${hoursOld} hours ago) and should have been replaced by ${until}. Use a newer pack if there is one, and check allergies, resuscitation status and diet with the nurse in charge before acting on it.`,
  };
}

export interface DowntimePageHeader {
  readonly lines: readonly string[];
  readonly state: DowntimeFreshnessState;
}

/**
 * The words at the top of every page, worked out at the moment the page is shown or printed: a
 * printed page cannot change later, so it carries its "use until" time, and a page printed from an
 * out-of-date pack, during an outage or on a device with a wrong clock says so (HZ-021).
 */
export function downtimePageHeader(
  pack: Pick<DowntimePack, "locationName" | "generatedAt" | "asAt" | "validUntil">,
  printedAt: Date,
  context: DowntimeFreshnessContext,
): DowntimePageHeader {
  const freshness = downtimePackFreshness(pack, printedAt, context);
  return {
    state: freshness.state,
    lines: [
      `Downtime pack for ${pack.locationName}`,
      freshness.notice,
      `Made ${packTime(pack.generatedAt)}. Printed or shown ${packTime(printedAt)}.`,
      DOWNTIME_BACK_ENTRY_INSTRUCTION,
    ],
  };
}

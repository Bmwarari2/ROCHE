import type { ResuscitationStatus } from "../care/advance-care";
import { PCSP_DOMAIN_LABELS, PCSP_DOMAINS, type PcspDomain } from "../care/care-plan";
import { describeIddsiLevel, type IddsiDrinkLevel, type IddsiFoodLevel } from "../care/iddsi";
import type { RiskBand } from "../care/risk-assessment";
import { LIVE_PERSON_STATUSES, type PersonStatus } from "../people/lifecycle";
import type {
  AllergyStatement,
  CommunicationStatement,
  SectionSource,
  TransferAllergy,
} from "../people/transfer-pack";
import { formatUkDateTime } from "../shared/time";
import type { OperationsRates } from "./rates";

/**
 * Nightly downtime pack (master prompt 13.4, fire safety and PEEPs row: "a nightly downtime pack
 * per location (MAR, care plan summaries, allergies, PEEPs, contacts) printed or cached on the kiosk
 * for power cuts and IT outages"; operations.md section 4 rules 1 to 4; hazard HZ-021).
 *
 * A pure function selects, for one location, a page per person receiving care. It copies what is
 * recorded and never interprets it (medical-device boundary). It never leaves a person out because
 * their record is incomplete: missing safety-critical information reads "not recorded" in words, a
 * section that belongs to someone else is withheld (HZ-001), and every page says when the
 * information is from and until when to use it, and, once that time has passed, that it is out of
 * date (HZ-021).
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
    key: "eating_and_drinking",
    title: "Eating and drinking (IDDSI levels)",
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
// Placeholder ports: PEEPs (operations, Phase 3 facilities) and medicines (eMAR, Phase 2)
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

export interface DueMedicine {
  readonly name: string;
  readonly dose: string;
  readonly route: string;
  readonly dueAt: Date;
  /** Time-critical medicines (for example for Parkinson's disease) are listed first at each time. */
  readonly timeCritical: boolean;
}

/** Medicines due while the pack is in use, from the eMAR, or where staff find them until then. */
export type MedicinesDueStatement =
  | { readonly status: "held_elsewhere"; readonly where: string }
  | { readonly status: "none_due" }
  | { readonly status: "due"; readonly items: readonly DueMedicine[] };

/** Implemented by the medicines module in Phase 2; the API calls it once per person. */
export interface DowntimeMedicinesPort {
  readonly provider: string;
  /** Medicines due for a person from `from` (inclusive) to `until` (exclusive). */
  medicinesDue(personId: string, from: Date, until: Date): Promise<MedicinesDueStatement>;
}

/** Implemented by the fire safety and PEEPs feature (OPS rows, Phase 3). */
export interface DowntimeEvacuationPort {
  readonly provider: string;
  evacuationPlan(personId: string): Promise<EvacuationPlanStatement>;
}

/** Phase 1: medicines are on the paper MAR chart, so the pack says where to look. */
export const PAPER_MAR_MEDICINES_PORT: DowntimeMedicinesPort = {
  provider: "paper_mar",
  medicinesDue: async () => ({ status: "held_elsewhere", where: "the paper MAR chart" }),
};

/** Until PEEPs are kept in Harbour, the pack points to the fire file. */
export const FIRE_FILE_EVACUATION_PORT: DowntimeEvacuationPort = {
  provider: "fire_file",
  evacuationPlan: async () => ({
    status: "held_elsewhere",
    where: "the person's PEEP in the fire file",
  }),
};

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

export interface DowntimeEatingAndDrinking {
  readonly foodLevel: IddsiFoodLevel | null;
  readonly drinkLevel: IddsiDrinkLevel | null;
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
  readonly resuscitation: SectionSource<ResuscitationStatus>;
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

export type DowntimeSectionState = "included" | "not_recorded" | "held_elsewhere" | "withheld";

export interface DowntimeSectionStatus {
  readonly key: DowntimeSectionKey;
  readonly title: string;
  readonly critical: boolean;
  readonly hazardIds: readonly string[];
  readonly status: DowntimeSectionState;
  readonly asOf: Date | null;
  /** The words printed in place of, or beside, the section's content. */
  readonly note: string | null;
}

export type DowntimeWarningKind =
  | "critical_not_recorded"
  | "resuscitation_conflict"
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
  /** For example "Level 6 Soft and bite-sized (blue)"; null when no level is recorded. */
  readonly food: string | null;
  readonly drink: string | null;
  readonly notes: string | null;
}

export interface DowntimeCarePlanLine {
  readonly domain: PcspDomain;
  readonly label: string;
  readonly need: string;
  readonly contingency: string | null;
}

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
    readonly resuscitation: ResuscitationStatus | null;
    readonly eatingAndDrinking: DowntimeIddsiContent | null;
    readonly communication: CommunicationStatement;
    readonly evacuation: EvacuationPlanStatement | null;
    readonly medicinesDue: MedicinesDueStatement | null;
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
  /** Every page's warnings, safety-critical gaps first, for the front sheet. */
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

/** Printed on the front sheet and every page's footer (operations.md rule 6). */
export const DOWNTIME_BACK_ENTRY_INSTRUCTION =
  "Write care on the downtime forms with the time you gave it. When Harbour is back, enter each form with that time and the outage it belongs to.";

const NOT_RECORDED_NOTES: Partial<Record<DowntimeSectionKey, string>> = {
  identity: "No photo on record. Confirm who the person is with a colleague who knows them.",
  allergies: "Allergies not recorded. Do not assume there are none.",
  resuscitation:
    "Resuscitation status not recorded. Check the person's documents and follow the home's policy.",
  eating_and_drinking:
    "IDDSI levels not recorded. Check with the nurse in charge before giving food or drink.",
  communication: "Communication needs not recorded. Ask the person or their family.",
  contacts: "No key contacts recorded.",
  care_plan: "No active care plan. Follow the paper care plan if there is one.",
  risks: "No active risk assessments recorded.",
};

const WITHHELD_NOTE =
  "Not included: this information did not match the person. Check the record when Harbour is back.";

const SEVERITY_ORDER: Record<TransferAllergy["severity"], number> = {
  severe: 0,
  moderate: 1,
  mild: 2,
  unknown: 3,
};

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });
const MS_PER_HOUR = 3_600_000;

function hasText(value: string | null | undefined): value is string {
  return (value?.trim().length ?? 0) > 0;
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

function medicinesInWindow(
  statement: MedicinesDueStatement,
  from: Date,
  until: Date,
): MedicinesDueStatement {
  if (statement.status !== "due") return statement;
  const items = statement.items
    .filter((m) => m.dueAt.getTime() >= from.getTime() && m.dueAt.getTime() < until.getTime())
    .sort(
      (a, b) =>
        a.dueAt.getTime() - b.dueAt.getTime() || Number(b.timeCritical) - Number(a.timeCritical),
    );
  return items.length === 0 ? { status: "none_due" } : { status: "due", items };
}

function iddsiContent(data: DowntimeEatingAndDrinking): DowntimeIddsiContent | null {
  if (data.foodLevel === null && data.drinkLevel === null) return null;
  return {
    food: data.foodLevel === null ? null : describeIddsiLevel("food", data.foodLevel),
    drink: data.drinkLevel === null ? null : describeIddsiLevel("drink", data.drinkLevel),
    notes: hasText(data.notes) ? data.notes.trim() : null,
  };
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
  const statuses = new Map<
    DowntimeSectionKey,
    { status: DowntimeSectionState; asOf: Date | null; where: string | null }
  >();
  const withheld = (key: DowntimeSectionKey) =>
    warnings.push({
      personId: person.personId,
      kind: "section_withheld",
      section: key,
      message: WITHHELD_NOTE,
    });
  const set = (
    key: DowntimeSectionKey,
    status: DowntimeSectionState,
    asOf: Date | null,
    where: string | null = null,
  ) => {
    statuses.set(key, { status, asOf, where });
    if (status === "withheld") withheld(key);
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

  const resusOwn = own(person.resuscitation);
  const resuscitation = resusOwn ? person.resuscitation.data : null;
  set(
    "resuscitation",
    !resusOwn ? "withheld" : resuscitation?.status === "not_recorded" ? "not_recorded" : "included",
    person.resuscitation.asOf,
  );
  if (resuscitation?.conflicting) {
    warnings.push({
      personId: person.personId,
      kind: "resuscitation_conflict",
      section: "resuscitation",
      message:
        "Resuscitation records disagree. Check the signed ReSPECT or DNACPR form before acting.",
    });
  }
  if (resuscitation && resuscitation.status !== "not_recorded" && resuscitation.reviewOverdue) {
    warnings.push({
      personId: person.personId,
      kind: "resuscitation_review_overdue",
      section: "resuscitation",
      message:
        "The resuscitation decision is past its review date. It still applies until changed.",
    });
  }

  const eatingOwn = own(person.eatingAndDrinking);
  const eating =
    eatingOwn && person.eatingAndDrinking ? iddsiContent(person.eatingAndDrinking.data) : null;
  set(
    "eating_and_drinking",
    !eatingOwn ? "withheld" : eating ? "included" : "not_recorded",
    person.eatingAndDrinking?.asOf ?? null,
  );

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
    set("evacuation", "held_elsewhere", person.evacuation.asOf, evacuation.where);
  else set("evacuation", "included", person.evacuation.asOf);

  const medicinesOwn = own(person.medicinesDue);
  const medicinesDue = medicinesOwn
    ? medicinesInWindow(person.medicinesDue.data, from, until)
    : null;
  if (!medicinesDue) set("medicines_due", "withheld", person.medicinesDue.asOf);
  else if (medicinesDue.status === "held_elsewhere")
    set("medicines_due", "held_elsewhere", person.medicinesDue.asOf, medicinesDue.where);
  else set("medicines_due", "included", person.medicinesDue.asOf);

  // A contact of someone else is left out and flagged; the person's own contacts still print.
  const contacts = person.contacts.filter((c) => c.personId === person.personId);
  if (contacts.length < person.contacts.length) withheld("contacts");
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
      where: null,
    };
    const note =
      state.status === "withheld"
        ? WITHHELD_NOTE
        : state.status === "not_recorded"
          ? (NOT_RECORDED_NOTES[definition.key] ?? null)
          : state.status === "held_elsewhere"
            ? `Not kept in Harbour yet. Use ${state.where}.`
            : null;
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
  for (const key of missingCritical) {
    warnings.unshift({
      personId: person.personId,
      kind: "critical_not_recorded",
      section: key,
      message: NOT_RECORDED_NOTES[key] ?? "Not recorded.",
    });
  }
  if (!person.dateOfBirth) {
    warnings.push({
      personId: person.personId,
      kind: "date_of_birth_not_recorded",
      section: "identity",
      message: "Date of birth not recorded. Confirm identity another way.",
    });
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
      eatingAndDrinking: eating,
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
  resuscitation_conflict: 1,
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

export interface DowntimeFreshness {
  readonly state: "current" | "out_of_date";
  readonly notice: string;
  /** Whole hours between the information's time and `at` (never negative). */
  readonly hoursOld: number;
}

/** Whether a pack is still in date at `at`, in words for the page. */
export function downtimePackFreshness(
  pack: Pick<DowntimePack, "asAt" | "validUntil">,
  at: Date,
): DowntimeFreshness {
  const asAt = formatUkDateTime(pack.asAt);
  const until = formatUkDateTime(pack.validUntil);
  const hoursOld = Math.max(0, Math.floor((at.getTime() - pack.asAt.getTime()) / MS_PER_HOUR));
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
  readonly outOfDate: boolean;
}

/**
 * The words at the top of every page, worked out at the moment the page is shown or printed: a
 * printed page cannot change later, so it carries its "use until" time, and a page printed from an
 * out-of-date pack says so (HZ-021).
 */
export function downtimePageHeader(
  pack: Pick<DowntimePack, "locationName" | "generatedAt" | "asAt" | "validUntil">,
  printedAt: Date,
): DowntimePageHeader {
  const freshness = downtimePackFreshness(pack, printedAt);
  return {
    outOfDate: freshness.state === "out_of_date",
    lines: [
      `Downtime pack for ${pack.locationName}`,
      freshness.notice,
      `Made ${formatUkDateTime(pack.generatedAt)}. Printed or shown ${formatUkDateTime(printedAt)}.`,
      DOWNTIME_BACK_ENTRY_INSTRUCTION,
    ],
  };
}

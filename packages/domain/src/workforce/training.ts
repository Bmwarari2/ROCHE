import { addYears, daysBetween } from "./dates";

/**
 * The training matrix (workforce.md rule 5; WORK-005). Topics from Skills for Care's core and
 * mandatory training guidance; which topics a role needs is the tenant's matrix. A record is valid
 * through its own expiry, or the day before completion plus the topic's refresh years
 * (`training.default_refresh_years` unless the tenant sets the topic's own). The Oliver McGowan
 * Mandatory Training (England) has two tiers refreshed every
 * `training.oliver_mcgowan.refresh_years`; tier 2 satisfies a tier 1 requirement, never the reverse.
 */

export const TRAINING_TOPICS = [
  "care_certificate",
  "safeguarding_adults",
  "safeguarding_children",
  "moving_and_handling",
  "infection_prevention_and_control",
  "fire_safety",
  "health_and_safety",
  "basic_life_support",
  "food_hygiene",
  "medicines",
  "mental_capacity_and_dols",
  "equality_diversity_and_human_rights",
  "information_governance",
  "dementia_awareness",
  "fluids_and_nutrition",
  "oliver_mcgowan",
] as const;

export type TrainingTopic = (typeof TRAINING_TOPICS)[number];

export type OliverMcGowanTier = 1 | 2;

export interface TrainingRequirement {
  readonly topic: TrainingTopic;
  /** The tenant's own refresh for this topic, in years; null for the default. */
  readonly refreshYears: number | null;
  /** For `oliver_mcgowan`: the tier the role needs. */
  readonly tier?: OliverMcGowanTier;
}

export interface TrainingRecord {
  readonly topic: TrainingTopic;
  readonly completedOn: string;
  /** A certificate's own last valid day, when it has one. */
  readonly expiresOn: string | null;
  readonly tier?: OliverMcGowanTier;
}

export type TrainingStatus = "valid" | "due_soon" | "expired" | "missing";

export interface TrainingState {
  readonly topic: TrainingTopic;
  readonly status: TrainingStatus;
  /** The last valid day of the record that counts, or null when missing. */
  readonly validUntil: string | null;
}

export interface TrainingRates {
  readonly trainingDefaultRefreshYears: number;
  /** Null outside England, where the tenant's requirement uses the default refresh. */
  readonly oliverMcGowanRefreshYears: number | null;
  /** How early a record shows as due soon: the first document-expiry reminder. */
  readonly reminderDaysFirst: number;
}

function validUntil(
  record: TrainingRecord,
  requirement: TrainingRequirement,
  rates: TrainingRates,
): string {
  if (record.expiresOn) return record.expiresOn;
  const years =
    requirement.topic === "oliver_mcgowan"
      ? (rates.oliverMcGowanRefreshYears ?? rates.trainingDefaultRefreshYears)
      : (requirement.refreshYears ?? rates.trainingDefaultRefreshYears);
  // Valid through the day before the anniversary.
  const anniversary = addYears(record.completedOn, years);
  const day = new Date(`${anniversary}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

function satisfies(record: TrainingRecord, requirement: TrainingRequirement): boolean {
  if (record.topic !== requirement.topic) return false;
  if (requirement.topic !== "oliver_mcgowan") return true;
  return (record.tier ?? 1) >= (requirement.tier ?? 1);
}

export function trainingState(
  requirement: TrainingRequirement,
  records: readonly TrainingRecord[],
  today: string,
  rates: TrainingRates,
): TrainingState {
  const candidates = records
    .filter((record) => satisfies(record, requirement) && record.completedOn <= today)
    .map((record) => validUntil(record, requirement, rates))
    .sort();
  const best = candidates.at(-1) ?? null;
  if (best === null) return { topic: requirement.topic, status: "missing", validUntil: null };
  const daysLeft = daysBetween(today, best);
  const status: TrainingStatus =
    daysLeft < 0 ? "expired" : daysLeft <= rates.reminderDaysFirst ? "due_soon" : "valid";
  return { topic: requirement.topic, status, validUntil: best };
}

/** The whole matrix for one worker: each required topic's state, missing and expired first. */
export function trainingMatrix(
  requirements: readonly TrainingRequirement[],
  records: readonly TrainingRecord[],
  today: string,
  rates: TrainingRates,
): readonly TrainingState[] {
  const order: Record<TrainingStatus, number> = { missing: 0, expired: 1, due_soon: 2, valid: 3 };
  return requirements
    .map((requirement) => trainingState(requirement, records, today, rates))
    .sort((a, b) => order[a.status] - order[b.status]);
}

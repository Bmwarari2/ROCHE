/**
 * Missing person (safety.md Phase 2 rule 5; SAFE-015; the Herbert Protocol; Regulation 18 where the
 * person is under a DoLS authorisation or the Mental Health Act). A timeline in order, a police call
 * target, the Herbert Protocol profile's age, and a return that needs a welfare check and a debrief.
 */

import type { SafetyPhase2Rates } from "./phase2-rates";

export type MissingEventKind =
  | "last_seen"
  | "noticed_missing"
  | "search_started"
  | "police_called"
  | "found"
  | "welfare_check"
  | "debrief";

export interface MissingEvent {
  readonly kind: MissingEventKind;
  readonly at: Date;
  /** The police reference, for `police_called`. */
  readonly reference?: string;
}

const ORDER: readonly MissingEventKind[] = [
  "last_seen",
  "noticed_missing",
  "search_started",
  "police_called",
  "found",
  "welfare_check",
  "debrief",
];

export interface MissingEpisode {
  readonly events: readonly MissingEvent[];
  readonly underDolsOrMha: boolean;
  /** When the Herbert Protocol profile was last reviewed, or null when there is none. */
  readonly herbertProfileReviewedOn: Date | null;
}

export interface MissingState {
  /** When police must be called by (a tenant target); null once called. */
  readonly policeCallDueAt: Date | null;
  readonly policeCallLate: boolean;
  readonly problems: readonly string[];
  readonly cqcNotificationPrompt: boolean;
  readonly herbertProfile: "none" | "current" | "out_of_date";
  readonly canClose: boolean;
}

function first(events: readonly MissingEvent[], kind: MissingEventKind): MissingEvent | undefined {
  return events.filter((e) => e.kind === kind).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
}

export function missingPersonState(
  episode: MissingEpisode,
  now: Date,
  rates: Pick<SafetyPhase2Rates, "missingPersonPoliceCallMinutes" | "herbertProtocolReviewMonths">,
): MissingState {
  const problems: string[] = [];
  const noticed = first(episode.events, "noticed_missing");
  const police = first(episode.events, "police_called");
  const found = first(episode.events, "found");
  // Events must not run backwards in the order a search happens.
  let previous: MissingEvent | undefined;
  for (const kind of ORDER) {
    const event = first(episode.events, kind);
    if (!event) continue;
    if (
      previous &&
      event.at.getTime() < previous.at.getTime() &&
      !(kind === "police_called" && previous.kind === "search_started")
    ) {
      problems.push(
        `The time for "${kind.replace(/_/g, " ")}" is before "${previous.kind.replace(/_/g, " ")}".`,
      );
    }
    previous = event;
  }
  if (police && !police.reference?.trim()) problems.push("Record the police reference.");
  const dueAt = noticed
    ? new Date(noticed.at.getTime() + rates.missingPersonPoliceCallMinutes * 60_000)
    : null;
  const policeCallLate = dueAt !== null && (police ? police.at > dueAt : now > dueAt);
  let herbert: MissingState["herbertProfile"] = "none";
  if (episode.herbertProfileReviewedOn) {
    const stale = new Date(episode.herbertProfileReviewedOn);
    stale.setUTCMonth(stale.getUTCMonth() + rates.herbertProtocolReviewMonths);
    herbert = now > stale ? "out_of_date" : "current";
  }
  const closeProblems: string[] = [];
  if (found) {
    if (!first(episode.events, "welfare_check"))
      closeProblems.push("Check the person's welfare on return.");
    if (!first(episode.events, "debrief")) closeProblems.push("Hold the debrief.");
  } else {
    closeProblems.push("The person has not been found yet.");
  }
  return {
    policeCallDueAt: police ? null : dueAt,
    policeCallLate,
    problems: [...problems, ...closeProblems],
    cqcNotificationPrompt: episode.underDolsOrMha,
    herbertProfile: herbert,
    canClose: problems.length === 0 && closeProblems.length === 0,
  };
}

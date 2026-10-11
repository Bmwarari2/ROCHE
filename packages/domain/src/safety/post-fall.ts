/**
 * Post-fall checklist (safety.md section 4 rule 12; SAFE-009; hazards HZ-014 and HZ-027). A fall
 * creates the checklist as tasks: injury check, observations, GP contact, the NICE NG249 falls
 * pathway and a bone health review. Head injury, or anticoagulant or antiplatelet treatment, turns
 * the general monitoring into timed observations and prompts urgent medical advice.
 *
 * Medical-device boundary: these are monitoring tasks from tenant-configurable figures and
 * published guidance, with the tenant's escalation policy linked. Harbour does not assess the
 * injury or recommend treatment.
 *
 * Sources (read 11 October 2026):
 * - NICE NG232 Head injury (2023) 1.2.4: community health services refer people with a head injury
 *   to an emergency department if there is, among other risk factors, "current anticoagulant or
 *   antiplatelet (except aspirin monotherapy) treatment".
 * - NICE NG232 1.9.11: observations for people with a GCS score of 15 "half-hourly for 2 hours,
 *   then 1 hourly for 4 hours, then 2 hourly". This is NICE's schedule for people admitted to
 *   hospital; using it in a care home is a default for the CSO to confirm (`to-verify`, H-66).
 * - Hertfordshire care home falls pathway (HCPA, May 2026): "Always monitor the person for 24 hours
 *   following a fall". A regional source, also `to-verify`.
 * Every figure comes from the rate table (`falls.*`).
 */

import { type Citation, cite, SOURCES } from "../shared/citation";
import type { SafetyRates } from "./rates";

export type PostFallTaskKind =
  | "post_fall_injury_check"
  | "urgent_medical_advice"
  | "post_fall_observations"
  | "post_fall_monitoring"
  | "gp_contact"
  | "ng249_falls_pathway"
  | "bone_health_review";

export interface PostFallTask {
  readonly task: PostFallTaskKind;
  readonly reason: string;
  /** Null when the tenant's task defaults set the due time. */
  readonly dueAt: Date | null;
  /** For a window of monitoring: when it ends. */
  readonly until?: Date;
  readonly sources: readonly Citation[];
}

export type YesNoUnsure = "yes" | "no" | "unsure";

export interface PostFallInput {
  readonly occurredAt: Date;
  /** When the person was found or the fall seen; observations count from here. Defaults to `occurredAt`. */
  readonly foundAt?: Date | null;
  /** Unanswered or unsure counts as yes: a head injury that cannot be ruled out is treated as one. */
  readonly headInjury: YesNoUnsure | null;
  readonly anticoagulantOrAntiplatelet: YesNoUnsure | null;
}

export interface ObservationPhase {
  readonly intervalMinutes: number;
  /** Null for the last phase, which runs to the end of monitoring. */
  readonly forHours: number | null;
}

export interface PostFallChecklist {
  readonly schedule: "general_monitoring" | "timed_observations";
  readonly phases: readonly ObservationPhase[];
  /** Each timed observation, as instants (elapsed time, so a clock change does not move them). */
  readonly observationTimes: readonly Date[];
  readonly monitoringUntil: Date;
  readonly tasks: readonly PostFallTask[];
  /** Why the schedule was chosen. */
  readonly reasons: readonly string[];
}

const NG232 = (p: string) => cite("NICE NG232", p, SOURCES.niceNg232);
const HCPA = cite(
  "Hertfordshire Care Providers Association",
  "Management of a person who has fallen: care home pathway (May 2026)",
  "https://www.hcpa.info/wp-content/uploads/2026/05/Management-of-a-person-who-has-fallen-in-a-care-home.pdf",
);
const MASTER = cite("Harbour master prompt", "11.1 (falls protocol)", "docs/00-MASTER-PROMPT.md");

const MINUTE = 60_000;

/** The post-fall tasks and observation times for one fall. */
export function postFallChecklist(input: PostFallInput, rates: SafetyRates): PostFallChecklist {
  const start = input.foundAt ?? input.occurredAt;
  const monitoringUntil = new Date(start.getTime() + rates.fallsMonitoringHours * 60 * MINUTE);
  const headInjury = input.headInjury !== "no";
  const anticoagulant = input.anticoagulantOrAntiplatelet !== "no";
  const timed = headInjury || anticoagulant;

  const reasons: string[] = [];
  if (headInjury) {
    reasons.push(
      input.headInjury === "yes"
        ? "Head injury after the fall"
        : "A head injury has not been ruled out, so it is treated as one",
    );
  }
  if (anticoagulant) {
    reasons.push(
      input.anticoagulantOrAntiplatelet === "yes"
        ? "Current anticoagulant or antiplatelet (except aspirin monotherapy) treatment"
        : "Anticoagulant or antiplatelet treatment has not been ruled out, so it is treated as present",
    );
  }

  const phases: ObservationPhase[] = timed
    ? [
        {
          intervalMinutes: rates.headInjuryPhase1IntervalMinutes,
          forHours: rates.headInjuryPhase1Hours,
        },
        {
          intervalMinutes: rates.headInjuryPhase2IntervalMinutes,
          forHours: rates.headInjuryPhase2Hours,
        },
        { intervalMinutes: rates.headInjuryPhase3IntervalMinutes, forHours: null },
      ]
    : [];
  const observationTimes: Date[] = [];
  let cursor = start.getTime();
  for (const phase of phases) {
    const phaseEnd =
      phase.forHours === null ? monitoringUntil.getTime() : cursor + phase.forHours * 60 * MINUTE;
    const end = Math.min(phaseEnd, monitoringUntil.getTime());
    for (
      let t = cursor + phase.intervalMinutes * MINUTE;
      t <= end;
      t += phase.intervalMinutes * MINUTE
    ) {
      observationTimes.push(new Date(t));
    }
    cursor = end;
  }

  const tasks: PostFallTask[] = [
    {
      task: "post_fall_injury_check",
      reason: "Check for injury before moving the person",
      dueAt: start,
      sources: [MASTER],
    },
  ];
  if (timed) {
    tasks.push(
      {
        task: "urgent_medical_advice",
        reason: `${reasons.join("; ")}. Seek urgent medical advice now, following your post-fall policy (NICE NG232 1.2.4)`,
        dueAt: start,
        sources: [NG232("1.2.4")],
      },
      {
        task: "post_fall_observations",
        reason: `Timed observations: ${phases
          .map((p) =>
            p.forHours === null
              ? `every ${p.intervalMinutes} minutes until ${rates.fallsMonitoringHours} hours after the fall`
              : `every ${p.intervalMinutes} minutes for ${p.forHours} hours`,
          )
          .join(", then ")} (default from NICE NG232 1.9.11; your clinical lead may change it)`,
        dueAt: observationTimes[0] ?? start,
        until: monitoringUntil,
        sources: [NG232("1.9.11")],
      },
    );
  } else {
    tasks.push({
      task: "post_fall_monitoring",
      reason: `Monitor for signs of deterioration for ${rates.fallsMonitoringHours} hours after the fall and complete the post-fall observation log`,
      dueAt: start,
      until: monitoringUntil,
      sources: [HCPA],
    });
  }
  tasks.push(
    {
      task: "gp_contact",
      reason: "Tell the person's GP about the fall",
      dueAt: null,
      sources: [MASTER],
    },
    {
      task: "ng249_falls_pathway",
      reason: "Follow the NICE NG249 falls pathway after a fall",
      dueAt: null,
      sources: [cite("NICE NG249", "1.1.2 to 1.1.7", SOURCES.niceNg249)],
    },
    {
      task: "bone_health_review",
      reason: "Review bone health after the fall",
      dueAt: null,
      sources: [MASTER],
    },
  );

  return {
    schedule: timed ? "timed_observations" : "general_monitoring",
    phases,
    observationTimes,
    monitoringUntil,
    tasks,
    reasons: timed ? reasons : ["No head injury and no anticoagulant or antiplatelet treatment"],
  };
}

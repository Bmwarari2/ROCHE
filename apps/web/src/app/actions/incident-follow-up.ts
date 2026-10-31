"use server";

import type { CandourView, InvestigationView, UpdateCandour } from "@harbour/contracts";
import type {
  AttemptInput,
  FollowUpInput,
  ThresholdInput,
  VerbalInput,
  WrittenInput,
} from "@/lib/candour";
import { sendAndRevalidate } from "@/lib/care-actions";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import type { InvestigationInput } from "@/lib/investigation";
import { type ActionResult, refused } from "@/lib/outcome";
import { isIsoInstant } from "@/lib/uk-time";

/**
 * Writes for the duty of candour record and the investigation on an incident (safety.md section
 * 5; register rows SAFE-007 and SAFE-010; hazards HZ-013 and HZ-091). Every write carries the
 * version the page was drawn from (0 starts the record), so a stale page is refused. "Just now"
 * is when the server receives the form, never the browser's clock (HZ-090). The API checks the
 * permission where the incident is, every rule and each step's needs again.
 */

/** The incident's page, the list and the notification pages (a threshold decision reclassifies). */
const paths = (incidentId: string) => [
  `/incidents/${incidentId}`,
  "/incidents",
  "/notifications/statutory",
];

/** A time from the form: null is "just now", taken here; anything else must be an instant. */
const momentOf = (value: string | null, now: string): string | null =>
  value === null ? now : isIsoInstant(value) ? value : null;

/** One change to the candour record: a part of it, as each form sends it. */
export type CandourChange =
  | { readonly part: "threshold"; readonly input: ThresholdInput }
  | { readonly part: "verbal"; readonly input: VerbalInput }
  | {
      readonly part: "attempt";
      readonly input: AttemptInput;
      /** The attempts already recorded, kept as they are. */
      readonly previous: readonly { readonly at: string; readonly note: string }[];
    }
  | { readonly part: "written"; readonly input: WrittenInput }
  | { readonly part: "followUp"; readonly input: FollowUpInput };

/** Record part of the duty of candour record (`safety.incident.manage`); version 0 starts it. */
export async function saveCandour(
  incidentId: string,
  change: CandourChange,
  version: number,
): Promise<ActionResult<CandourView>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  const now = new Date().toISOString();
  const invalid = (field: string) =>
    refused(t("safety.candour.error", { field: "when" }), "invalid", [field]);
  let body: Omit<UpdateCandour, "version">;
  switch (change.part) {
    case "threshold": {
      const decidedAt = momentOf(change.input.decidedAt, now);
      if (!decidedAt) return invalid("decidedAt");
      body = {
        ...(change.input.personId ? { personId: change.input.personId } : {}),
        threshold: {
          notifiable: change.input.notifiable,
          decidedAt,
          decidedBy: change.input.decidedBy,
        },
        // The API asks for these when the decision differs from Harbour's finding or changes a
        // recorded one; the form asked for both first (#120 round 2, M3).
        ...(change.input.reason
          ? { thresholdReason: change.input.reason, thresholdConfirmed: true }
          : {}),
      };
      break;
    }
    case "verbal": {
      const at = momentOf(change.input.at, now);
      if (!at) return invalid("at");
      body = {
        verbal: { ...change.input, byRepresentatives: [...change.input.byRepresentatives], at },
      };
      break;
    }
    case "attempt": {
      const at = momentOf(change.input.at, now);
      if (!at) return invalid("attemptAt");
      body = {
        contactAttempts: [
          ...change.previous.map((a) => ({ at: a.at, note: a.note })),
          { at, note: change.input.note },
        ],
      };
      break;
    }
    case "written": {
      const sentAt = momentOf(change.input.sentAt, now);
      if (!sentAt) return invalid("sentAt");
      body = { written: { ...change.input, sentAt } };
      break;
    }
    case "followUp": {
      const shared = change.input.enquiryResultsSharedAt;
      if (shared !== null && !isIsoInstant(shared)) return invalid("resultsSharedAt");
      body = {
        enquiryResultsSharedAt: shared,
        correspondenceDocumentIds: change.input.correspondenceDocumentIds.filter(isUuid),
        outcome: change.input.outcome,
      };
      break;
    }
  }
  const saved = await sendAndRevalidate(paths(incidentId), (api) =>
    api.PUT("/v1/incidents/{id}/candour", {
      params: { path: { id: incidentId } },
      body: { ...body, version },
    }),
  );
  // A decision that differs from Harbour's finding, or changes one, moves the record on at once
  // with its reason, so the reason is kept with the record (review M4). If the step is refused,
  // the decision stands and the page offers the step again, asking for the reason.
  if (!saved.ok || change.part !== "threshold" || !change.input.reason) return saved;
  const record = saved.data.record;
  if (!record) return saved;
  const reason = change.input.reason;
  const to = change.input.notifiable ? "verbal_due" : "not_notifiable";
  return sendAndRevalidate(paths(incidentId), (api) =>
    api.POST("/v1/incidents/{id}/candour/step", {
      params: { path: { id: incidentId } },
      body: {
        to,
        reason,
        confirmed: true,
        version: record.version,
      },
    }),
  );
}

/** Take the next step of the duty of candour record (`safety.incident.manage`). */
export async function stepCandour(
  incidentId: string,
  input: {
    readonly to:
      | "verbal_due"
      | "not_notifiable"
      | "written_due"
      | "no_contact"
      | "enquiries_open"
      | "closed";
    readonly reason?: string;
    /** "Not notifiable" after Harbour drafted a candour notification was confirmed. */
    readonly confirmed?: boolean;
    readonly version: number;
  },
): Promise<ActionResult<CandourView>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(paths(incidentId), (api) =>
    api.POST("/v1/incidents/{id}/candour/step", {
      params: { path: { id: incidentId } },
      body: {
        to: input.to,
        version: input.version,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.confirmed ? { confirmed: true } : {}),
      },
    }),
  );
}

/**
 * Reopen a record finished as not notifiable or no contact (`safety.incident.manage`), with a
 * reason of at least 20 characters (#120 review round 3, H1).
 */
export async function reopenCandour(
  incidentId: string,
  input: { readonly reason: string; readonly version: number },
): Promise<ActionResult<CandourView>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(paths(incidentId), (api) =>
    api.POST("/v1/incidents/{id}/candour/reopen", {
      params: { path: { id: incidentId } },
      body: { reason: input.reason, version: input.version },
    }),
  );
}

/**
 * Record the investigation (`safety.incident.manage`); version 0 starts it. Each action with an
 * owner and a date becomes a task for its owner; the actions already there are sent with their
 * ids, so their tasks stay theirs.
 */
export async function saveInvestigation(
  incidentId: string,
  input: InvestigationInput,
  version: number,
): Promise<ActionResult<InvestigationView>> {
  if (!isUuid(incidentId)) return refused(t("errors.notFound"), "not_found");
  return sendAndRevalidate(paths(incidentId), (api) =>
    api.PUT("/v1/incidents/{id}/investigation", {
      params: { path: { id: incidentId } },
      body: {
        leadTenantUserId: input.leadTenantUserId,
        method: input.method,
        findings: input.findings,
        contributingFactors: [...input.contributingFactors],
        lessons: input.lessons,
        actions: input.actions.map((a) => ({
          ...(a.id ? { id: a.id } : {}),
          action: a.action,
          ownerTenantUserId: a.ownerTenantUserId,
          dueOn: a.dueOn,
          status: a.status,
        })),
        ...(input.bulletinPublished ? { bulletinPublished: true } : {}),
        status: input.status,
        version,
      },
    }),
  );
}

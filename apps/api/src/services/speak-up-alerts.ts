import { auditEvent, notification, type Transaction } from "@harbour/db";
import { permissionHolders, withTenantWideScope } from "./safety";

/**
 * A speak-up concern no active Freedom to Speak Up lead can be told about: audited as the system,
 * coded `no_active_lead`, and counted in the operator's daily unrouted signal (clinical review,
 * finding 3; HZ-131). Nobody in the organisation is told at intake, since an alert at that moment
 * would date the concern for whoever reads it (H-1152 asks the guardian who should be).
 */
export const SPEAK_UP_UNROUTED_ACTION = "safety.speak_up.unrouted";

/**
 * A speak-up concern is never left unseen (HZ-131; the gap found by the slice 83 guides): when one
 * arrives, every Freedom to Speak Up lead (the holders of `safety.speak_up.manage`) is told, in
 * the app, to open their cases. The alert names no reporter and says nothing of the concern beyond
 * whether it is about care quality or safety, which makes it urgent. It carries the real time:
 * the lead's case list already dates the concern, and a time-ordered id would give the time away
 * anyway, so blurring it would only bury the alert (clinical review, finding 4). It escalates to
 * nobody else: anyone outside the leads may be the person the concern is about (H-1152). Returns
 * how many leads were told.
 */
export async function tellSpeakUpLeads(
  tx: Transaction,
  tenantId: string,
  concernId: string,
  category: string,
  now: Date,
): Promise<number> {
  return withTenantWideScope(tx, async () => {
    const leads = await permissionHolders(tx, "safety.speak_up.manage", null, now);
    if (leads.length === 0) {
      await tx.insert(auditEvent).values({
        tenantId,
        action: SPEAK_UP_UNROUTED_ACTION,
        outcome: "error",
        resourceType: "speak_up_concern",
        resourceId: concernId,
        reason: "no_active_lead",
        scope: { reasonCode: "no_active_lead" },
      });
      return 0;
    }
    const urgent = category === "care_quality_or_safety";
    for (const lead of leads) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: lead,
          kind: "safety.speak_up.received",
          severity: urgent ? "urgent" : "warning",
          title: urgent
            ? "A speak-up concern about care quality or safety has arrived"
            : "A speak-up concern has arrived",
          body: "Open your speak-up cases to acknowledge it.",
          link: "/speak-up/cases",
          channels: ["in_app"],
          sourceType: "speak_up_concern",
          sourceId: concernId,
          dedupeKey: `speak_up_received:${concernId}:${lead}`,
          createdAt: now,
        })
        .onConflictDoNothing();
    }
    return leads.length;
  });
}

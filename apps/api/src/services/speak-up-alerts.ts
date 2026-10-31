import { auditEvent, notification, type Transaction } from "@harbour/db";
import { ukDayBounds, ukIsoDate } from "@harbour/domain";
import { permissionHolders, withTenantWideScope } from "./safety";

/**
 * A speak-up concern is never left unseen (HZ-126; the gap found by the slice 83 guides): when one
 * arrives, every Freedom to Speak Up lead (the holders of `safety.speak_up.manage`) is told to
 * open their cases. The alert names no reporter and says nothing of the concern. For an anonymous
 * concern it is dated to the start of the UK day it arrived and sent in the app only, never by
 * push, so its time cannot help work out who raised it (the concern itself keeps only the day).
 * It escalates to nobody else: anyone outside the leads may be the person the concern is about
 * (H-1152 asks the Freedom to Speak Up guardian about escalation). Nobody to tell is audited.
 * Returns how many leads were told.
 */
export async function tellSpeakUpLeads(
  tx: Transaction,
  tenantId: string,
  concernId: string,
  anonymous: boolean,
  now: Date,
): Promise<number> {
  return withTenantWideScope(tx, async () => {
    const leads = await permissionHolders(tx, "safety.speak_up.manage", null, now);
    if (leads.length === 0) {
      await tx.insert(auditEvent).values({
        tenantId,
        action: "safety.speak_up.unrouted",
        outcome: "error",
        resourceType: "speak_up_concern",
        resourceId: concernId,
        reason: "no_active_lead",
        scope: { reasonCode: "no_active_lead" },
      });
      return 0;
    }
    const when = anonymous ? ukDayBounds(ukIsoDate(now)).startsAt : now;
    for (const lead of leads) {
      await tx
        .insert(notification)
        .values({
          recipientTenantUserId: lead,
          kind: "safety.speak_up.received",
          severity: "warning",
          title: "A speak-up concern has arrived",
          body: "Open your speak-up cases to acknowledge it.",
          link: "/speak-up/cases",
          channels: anonymous ? ["in_app"] : ["in_app", "push"],
          sourceType: "speak_up_concern",
          sourceId: concernId,
          dedupeKey: `speak_up_received:${concernId}:${lead}`,
          createdAt: when,
        })
        .onConflictDoNothing();
    }
    return leads.length;
  });
}

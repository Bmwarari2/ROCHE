import { notification, type Transaction, tenant } from "@harbour/db";
import { eq } from "drizzle-orm";
import { roleHolders } from "./role-holders";

/**
 * Tells an organisation that Thapsus has sent a breach notice (platform.md rule 24;
 * breach-response.md section 2 step 4: "the tenant's DPO and Owner roles"): its named data
 * protection lead and its owners, urgently, in the app and by email. Idempotent: each recipient's
 * notification has a dedupe key from the notice, so a retried outbox event tells no one twice. A
 * generic title with ids only; the register says the rest.
 */
export async function tellAboutBreachNotice(
  tx: Transaction,
  tenantId: string,
  noticeId: string,
  now: Date,
): Promise<number> {
  const [t] = await tx
    .select({ leadId: tenant.dataProtectionLeadId })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const owners = await roleHolders(tx, ["owner"], null, now);
  const recipients = [...new Set([...(t?.leadId ? [t.leadId] : []), ...owners])];
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: "platform.breach.processor_notice_sent",
        severity: "urgent",
        title: "Thapsus has told you about a personal data breach",
        body: "Open the breach register: the ICO clock may already be running.",
        link: "/settings/data-protection",
        channels: ["in_app", "email"],
        sourceType: "processor_breach_notice",
        sourceId: noticeId,
        dedupeKey: `platform.breach.processor_notice_sent:${noticeId}`,
      })
      .onConflictDoNothing();
  }
  return recipients.length;
}

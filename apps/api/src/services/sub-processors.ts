import { integrationConnection, notification, type Transaction, tenant } from "@harbour/db";
import type { AiProvider, FlagKey, SubProcessorConfig } from "@harbour/domain";
import { eq } from "drizzle-orm";
import type { FlagService } from "../flags/provider";
import { tenantFlags } from "./dpia";
import { roleHolders } from "./role-holders";

/**
 * Which sub-processors an organisation's configuration uses (platform-completions.md rule 23):
 * the modules in force (an AI provider chosen counts the AI module as planned, as the DPIA does),
 * push to staff phones always, SMS when an SMS provider is connected. Reads configuration only,
 * never people, so the operator's notice can work out whom a change affects.
 */
export async function subProcessorConfigFor(
  tx: Transaction,
  flags: FlagService,
  t: typeof tenant.$inferSelect,
): Promise<SubProcessorConfig> {
  const inForce = await tenantFlags(flags, tx, t.id);
  const features = Object.entries(inForce)
    .filter(([key, on]) => on && key.startsWith("module."))
    .map(([key]) => key as FlagKey);
  if (t.aiProvider && !features.includes("module.ai" as FlagKey)) {
    features.push("module.ai" as FlagKey);
  }
  const [sms] = await tx
    .select({ id: integrationConnection.id })
    .from(integrationConnection)
    .where(eq(integrationConnection.port, "comms.sms"))
    .limit(1);
  return {
    features,
    capabilities: { mobilePush: true, sms: sms !== undefined },
    aiProvider: (t.aiProvider as AiProvider | null) ?? null,
  };
}

const TOLD: Readonly<Record<string, string>> = {
  "platform.sub_processor.notice_announced": "A sub-processor change needs your answer",
  "platform.sub_processor.objection_resolved":
    "Your objection to a sub-processor change has been resolved",
};

/**
 * Tells the organisation's data protection lead (its owners when none is named) about a notice
 * or a resolution, from the outbox event its definer function wrote. Idempotent: each recipient's
 * notification has a dedupe key from the event and the notice (a resolution: its response id, so
 * a second objection's resolution is told too), so a retried event tells no one twice. A generic title; the page says the rest.
 */
export async function tellAboutNotice(
  tx: Transaction,
  tenantId: string,
  eventType: string,
  noticeId: string,
  now: Date,
  /** The resolution's response id: each resolution is told, a later one after an earlier one. */
  responseId: string | null = null,
): Promise<void> {
  const title = TOLD[eventType];
  if (!title) return;
  const [t] = await tx
    .select({ leadId: tenant.dataProtectionLeadId })
    .from(tenant)
    .where(eq(tenant.id, tenantId));
  const recipients = t?.leadId ? [t.leadId] : await roleHolders(tx, ["owner"], null, now);
  for (const recipient of recipients) {
    await tx
      .insert(notification)
      .values({
        recipientTenantUserId: recipient,
        kind: eventType,
        severity: "warning",
        title,
        link: "/settings/data-protection",
        channels: ["in_app", "email"],
        sourceType: "sub_processor_notice",
        sourceId: noticeId,
        dedupeKey: `${eventType}:${responseId ?? noticeId}`,
      })
      .onConflictDoNothing();
  }
}

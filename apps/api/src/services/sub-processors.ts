import { integrationConnection, type Transaction, type tenant } from "@harbour/db";
import type { AiProvider, FlagKey, SubProcessorConfig } from "@harbour/domain";
import { eq } from "drizzle-orm";
import type { FlagService } from "../flags/provider";
import { tenantFlags } from "./dpia";

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

import type { Transaction } from "@harbour/db";
import { integrationConnection } from "@harbour/db";
import {
  type OutboundMessage,
  type PortName,
  type SendResult,
  smsGatewayConfigured,
} from "@harbour/domain";
import { eq } from "drizzle-orm";
import { type AdapterFactoryOptions, createAdapter } from "./adapters";

/** What the delivery job needs from any communication adapter. */
export interface ChannelAdapter {
  readonly provider: string;
  /** `body` is read by the email port only (H-225). */
  send(
    message: OutboundMessage & { readonly to: string; readonly body?: string },
  ): Promise<SendResult>;
}

const PORT_FOR_CHANNEL: Record<"email" | "sms" | "push", PortName> = {
  email: "comms.email",
  sms: "comms.sms",
  push: "comms.push",
};

/** Resolves a tenant's adapter for a channel from its `integration_connection` row (mock if none). */
export function createAdapterResolver(options: AdapterFactoryOptions) {
  return async (
    _tenantId: string,
    channel: "email" | "sms" | "push",
    tx: Transaction,
  ): Promise<ChannelAdapter> => {
    const port = PORT_FOR_CHANNEL[channel];
    const [connection] = await tx
      .select({
        provider: integrationConnection.provider,
        settings: integrationConnection.settings,
      })
      .from(integrationConnection)
      .where(eq(integrationConnection.port, port));
    const adapter = createAdapter(
      port,
      connection
        ? {
            provider: connection.provider,
            settings: connection.settings as Record<string, unknown>,
          }
        : null,
      options,
    );
    if (port === "comms.push") {
      return {
        provider: adapter.provider,
        send: (message) =>
          (adapter as { send(m: unknown): Promise<SendResult> }).send({
            ...message,
            to: [message.to],
          }),
      };
    }
    return adapter as ChannelAdapter;
  };
}

/**
 * Whether the organisation can really send text messages: a connected SMS gateway, never the mock
 * (ADR-0132: no SMS at launch). Read in the caller's transaction, under its RLS.
 */
export async function smsAvailable(tx: Transaction): Promise<boolean> {
  const [connection] = await tx
    .select({ provider: integrationConnection.provider, status: integrationConnection.status })
    .from(integrationConnection)
    .where(eq(integrationConnection.port, "comms.sms"));
  return smsGatewayConfigured(connection ?? null);
}

/**
 * Whether a phone notification can reach a member of staff. Not yet: staff devices do not register
 * push tokens, so `processDeliveries` finds no destination and skips it. Until they do, a lone-worker
 * route step must include email (HZ-125; ADR-0132).
 */
export const STAFF_PUSH_AVAILABLE = false;

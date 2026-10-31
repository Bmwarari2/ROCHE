import type { XeroPayBatch } from "@harbour/domain";

/**
 * Xero Payroll UK behind the payroll export port (scheduling.md section 19 rule 8; ADR-0013,
 * ADR-0097). The adapter reads the organisation's OAuth tokens from the managed secret store by the
 * connection's `secret_ref` (never from the database) and sends one batch for a locked run. Only a
 * contract-tested mock client exists: no call leaves Harbour until the Xero developer app is
 * registered, the live client is built against Xero's sandbox and the provider is assessed as the
 * organisation's processor (H-518, H-520, H-1190).
 */

/** What the adapter needs from the secret store: the access token held under a secret's name. */
export interface PayrollSecretStore {
  accessToken(secretRef: string): Promise<string | null>;
}

/** The provider call, as the adapter makes it: one batch for one organisation, one id back. */
export interface XeroPayrollClient {
  submitPayBatch(input: {
    readonly accessToken: string;
    readonly xeroTenantId: string;
    readonly batch: XeroPayBatch;
  }): Promise<{ readonly batchId: string }>;
}

export class PayrollNotConnected extends Error {
  constructor() {
    super("payroll_not_connected");
  }
}

export interface PayrollSendResult {
  readonly outcome: "sent" | "failed";
  readonly externalRef: string | null;
}

/** The Xero adapter: tokens from the secret store, one batch, the provider's id back. */
export class XeroPayrollAdapter {
  constructor(
    private readonly client: XeroPayrollClient,
    private readonly secrets: PayrollSecretStore,
  ) {}

  async send(
    connection: { readonly secretRef: string; readonly externalOrganisationId: string },
    batch: XeroPayBatch,
  ): Promise<PayrollSendResult> {
    const accessToken = await this.secrets.accessToken(connection.secretRef);
    if (!accessToken) throw new PayrollNotConnected();
    try {
      const { batchId } = await this.client.submitPayBatch({
        accessToken,
        xeroTenantId: connection.externalOrganisationId,
        batch,
      });
      return {
        outcome: "sent",
        externalRef: /^[A-Za-z0-9-]{1,64}$/.test(batchId) ? batchId : null,
      };
    } catch {
      // The provider's words never reach the record or the log: only that it failed.
      return { outcome: "failed", externalRef: null };
    }
  }
}

/**
 * The mock client: records each batch it is given and answers with a batch id, never calling
 * anything. Development and tests only; production refuses it (config.ts).
 */
export class MockXeroPayrollClient implements XeroPayrollClient {
  readonly received: { xeroTenantId: string; batch: XeroPayBatch }[] = [];
  failNext = false;
  async submitPayBatch(input: {
    readonly accessToken: string;
    readonly xeroTenantId: string;
    readonly batch: XeroPayBatch;
  }): Promise<{ readonly batchId: string }> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock failure");
    }
    this.received.push({ xeroTenantId: input.xeroTenantId, batch: input.batch });
    return { batchId: `mock-batch-${this.received.length}` };
  }
}

/** Tokens by secret name from a JSON map (development and tests only). */
export class MemoryPayrollSecretStore implements PayrollSecretStore {
  constructor(private readonly tokens: Readonly<Record<string, string>>) {}
  async accessToken(secretRef: string): Promise<string | null> {
    return this.tokens[secretRef] ?? null;
  }
}

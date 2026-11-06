import type { LmsCompletionInput } from "@harbour/domain";

/**
 * The learning platform port (workforce.md section 13 rules 1 and 8; ADR-0102). An API source's
 * completions are pulled through it, and a completion's certificate fetched by the platform's
 * record id. The adapter reads the source's credentials from the managed secret store by the
 * source's `secret_ref` (never from the database). Only a contract-tested mock exists: no call
 * leaves Harbour until a platform is chosen, its client built against its sandbox and the platform
 * assessed as the organisation's processor (H-520, H-1250).
 */

export interface LearningPlatformSource {
  readonly secretRef: string | null;
  readonly externalOrganisationId: string | null;
}

/** The provider calls, as the adapter makes them. */
export interface LearningPlatformClient {
  listCompletions(input: {
    readonly credential: string;
    readonly organisationId: string;
  }): Promise<readonly LmsCompletionInput[]>;
  certificate(input: {
    readonly credential: string;
    readonly organisationId: string;
    readonly recordId: string;
  }): Promise<Uint8Array | null>;
}

/**
 * What the managed store holds under a source's secret: the credential and the platform
 * organisation it was issued for, written by the connection handshake. The adapter uses only that
 * organisation, so a caller's `external_organisation_id` can never reach another's data (security
 * review M4).
 */
export interface LearningPlatformSecret {
  readonly credential: string;
  readonly organisationId: string;
}

export interface LearningPlatformSecrets {
  secret(secretRef: string): Promise<LearningPlatformSecret | null>;
}

export class LearningPlatformNotConnected extends Error {
  constructor() {
    super("learning_platform_not_connected");
  }
}

/** The platform did not answer, or refused: the provider's words are never kept. */
export class LearningPlatformUnavailable extends Error {
  constructor() {
    super("learning_platform_unavailable");
  }
}

/** Most completions one pull may return; more is refused, as a file over the row limit. */
export const PULL_LIMIT = 5000;
/** A certificate's largest size, as the document category's (10 MB). */
export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024;
/** How long one call may take before it is given up (security review M3). */
export const CALL_TIMEOUT_MS = 10_000;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class LearningPlatformAdapter {
  constructor(
    private readonly client: LearningPlatformClient,
    private readonly secrets: LearningPlatformSecrets,
  ) {}

  private async open(source: LearningPlatformSource) {
    if (!source.secretRef || !source.externalOrganisationId)
      throw new LearningPlatformNotConnected();
    const secret = await this.secrets.secret(source.secretRef);
    if (!secret || secret.organisationId !== source.externalOrganisationId) {
      throw new LearningPlatformNotConnected();
    }
    return { credential: secret.credential, organisationId: secret.organisationId };
  }

  async pull(source: LearningPlatformSource): Promise<readonly LmsCompletionInput[]> {
    const opened = await this.open(source);
    let completions: readonly LmsCompletionInput[];
    try {
      completions = await within(this.client.listCompletions(opened), CALL_TIMEOUT_MS * 3);
    } catch {
      throw new LearningPlatformUnavailable();
    }
    if (completions.length > PULL_LIMIT) throw new LearningPlatformUnavailable();
    return completions;
  }

  /** A certificate's bytes, or null when the platform has none or cannot give it now. */
  async certificate(source: LearningPlatformSource, recordId: string): Promise<Uint8Array | null> {
    const opened = await this.open(source);
    try {
      const bytes = await within(this.client.certificate({ ...opened, recordId }), CALL_TIMEOUT_MS);
      return bytes && bytes.length <= CERTIFICATE_MAX_BYTES ? bytes : null;
    } catch {
      return null;
    }
  }
}

/**
 * The mock client: answers with the completions and certificates it is given, calling nothing.
 * Development and tests only; production refuses it (config.ts).
 */
export class MockLearningPlatformClient implements LearningPlatformClient {
  completions: LmsCompletionInput[] = [];
  readonly certificates = new Map<string, Uint8Array>();
  readonly calls: { organisationId: string; recordId?: string }[] = [];
  failNext = false;
  async listCompletions(input: {
    readonly credential: string;
    readonly organisationId: string;
  }): Promise<readonly LmsCompletionInput[]> {
    this.calls.push({ organisationId: input.organisationId });
    if (this.failNext) {
      this.failNext = false;
      throw new Error("mock failure");
    }
    return this.completions;
  }
  async certificate(input: {
    readonly credential: string;
    readonly organisationId: string;
    readonly recordId: string;
  }): Promise<Uint8Array | null> {
    this.calls.push({ organisationId: input.organisationId, recordId: input.recordId });
    return this.certificates.get(input.recordId) ?? null;
  }
}

/** Credentials by secret name, in memory (development and tests only). */
export class MemoryLearningPlatformSecrets implements LearningPlatformSecrets {
  private readonly values = new Map<string, LearningPlatformSecret>();
  put(secretRef: string, secret: LearningPlatformSecret): void {
    this.values.set(secretRef, secret);
  }
  async secret(secretRef: string): Promise<LearningPlatformSecret | null> {
    return this.values.get(secretRef) ?? null;
  }
}

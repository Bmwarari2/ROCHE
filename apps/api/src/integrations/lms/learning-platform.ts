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

export interface LearningPlatformSecrets {
  credential(secretRef: string): Promise<string | null>;
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

export class LearningPlatformAdapter {
  constructor(
    private readonly client: LearningPlatformClient,
    private readonly secrets: LearningPlatformSecrets,
  ) {}

  private async open(source: LearningPlatformSource) {
    if (!source.secretRef || !source.externalOrganisationId)
      throw new LearningPlatformNotConnected();
    const credential = await this.secrets.credential(source.secretRef);
    if (!credential) throw new LearningPlatformNotConnected();
    return { credential, organisationId: source.externalOrganisationId };
  }

  async pull(source: LearningPlatformSource): Promise<readonly LmsCompletionInput[]> {
    const opened = await this.open(source);
    let completions: readonly LmsCompletionInput[];
    try {
      completions = await this.client.listCompletions(opened);
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
      return await this.client.certificate({ ...opened, recordId });
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
  private readonly values = new Map<string, string>();
  put(secretRef: string, credential: string): void {
    this.values.set(secretRef, credential);
  }
  async credential(secretRef: string): Promise<string | null> {
    return this.values.get(secretRef) ?? null;
  }
}

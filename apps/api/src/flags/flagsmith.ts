import { z } from "zod";
import type { Logger } from "../logger";

/**
 * The optional Flagsmith source (ADR-0001, H-13): self-hosted by Thapsus in eu-west-2, used only
 * when `FLAGSMITH_ENVIRONMENT_KEY` is set. It is told opaque ids only (the organisation and the
 * location), never anything about a person. Each identity's flags are kept for
 * `FLAGSMITH_CACHE_SECONDS`, and so is an unanswered or unreadable reply, so an outage costs one
 * timed-out call per identity per period and every evaluation then falls back to the catalogue.
 */

export interface RemoteIdentity {
  readonly tenantId: string;
  readonly locationId: string | null;
}

/** The flags Flagsmith holds for an identity (name to enabled), or null when it did not answer. */
export interface RemoteFlags {
  flagsFor(identity: RemoteIdentity): Promise<ReadonlyMap<string, boolean> | null>;
}

export interface FlagsmithOptions {
  readonly apiUrl: string;
  readonly environmentKey: string;
  readonly timeoutMs: number;
  readonly cacheSeconds: number;
}

const IdentityReply = z.object({
  flags: z.array(z.object({ enabled: z.boolean(), feature: z.object({ name: z.string() }) })),
});

/** Identities kept at once; past this the cache starts again (a bound, not a tuning figure). */
const MAX_CACHED_IDENTITIES = 5000;

type Entry = {
  readonly expiresAt: number;
  readonly flags: Promise<ReadonlyMap<string, boolean> | null>;
};

export class FlagsmithFlags implements RemoteFlags {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly options: FlagsmithOptions,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  flagsFor(identity: RemoteIdentity): Promise<ReadonlyMap<string, boolean> | null> {
    const identifier = identity.locationId
      ? `${identity.tenantId}:${identity.locationId}`
      : identity.tenantId;
    const cached = this.cache.get(identifier);
    if (cached && cached.expiresAt > this.now()) return cached.flags;
    if (this.cache.size >= MAX_CACHED_IDENTITIES) this.cache.clear();
    const flags = this.fetchIdentity(identifier, identity);
    this.cache.set(identifier, {
      expiresAt: this.now() + this.options.cacheSeconds * 1000,
      flags,
    });
    return flags;
  }

  private async fetchIdentity(
    identifier: string,
    identity: RemoteIdentity,
  ): Promise<ReadonlyMap<string, boolean> | null> {
    const traits = [{ trait_key: "tenant_id", trait_value: identity.tenantId }];
    if (identity.locationId) {
      traits.push({ trait_key: "location_id", trait_value: identity.locationId });
    }
    try {
      const response = await this.fetchFn(
        `${this.options.apiUrl.replace(/\/+$/, "")}/identities/`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-environment-key": this.options.environmentKey,
          },
          body: JSON.stringify({ identifier, traits }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      const reply = IdentityReply.safeParse(await response.json());
      if (!reply.success) throw new Error("unreadable reply");
      return new Map(reply.data.flags.map((f) => [f.feature.name, f.enabled]));
    } catch (error) {
      // No ids in the log line: the operator needs to know Flagsmith is down, not for whom.
      this.logger.warn(
        {
          event: "flags.remote_unavailable",
          error: error instanceof Error ? error.name : "unknown",
        },
        "Flagsmith did not answer; flags fall back to the catalogue",
      );
      return null;
    }
  }
}

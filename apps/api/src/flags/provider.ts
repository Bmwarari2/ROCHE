import {
  FLAGS,
  type FlagKey,
  type FlagRow,
  isFlagKey,
  remoteMaySet,
  resolveFlag,
} from "@harbour/domain";
import {
  type EvaluationContext,
  FlagNotFoundError,
  InvalidContextError,
  type JsonValue,
  OpenFeature,
  type Provider,
  type ResolutionDetails,
  StandardResolutionReasons,
  TypeMismatchError,
} from "@openfeature/server-sdk";
import { z } from "zod";
import type { Config } from "../config";
import type { Logger } from "../logger";
import { FlagsmithFlags, type RemoteFlags } from "./flagsmith";

/**
 * The OpenFeature provider for Harbour's flag catalogue (section 9.1, PLAT-003). It reads the
 * organisation's own `feature_flag` rows from the evaluation context (read by the caller in its
 * request transaction, soft-deleted rows left out) and evaluates `resolveFlag`: the location
 * row, then the tenant row, then Flagsmith where configured and allowed to set the flag
 * (`remoteMaySet`: licensed modules, never AI), then the catalogue default. Every catalogue flag
 * is a boolean; any other type is refused, and the SDK then answers the caller's default.
 */

const Context = z.object({
  tenantId: z.string().min(1),
  locationId: z.string().min(1).nullable(),
  overrides: z.array(
    z.object({ flagKey: z.string(), locationId: z.string().nullable(), enabled: z.boolean() }),
  ),
});

export class HarbourFlagProvider implements Provider {
  readonly metadata = { name: "harbour-catalogue" };
  readonly runsOn = "server" as const;

  constructor(private readonly remote: RemoteFlags | null) {}

  async resolveBooleanEvaluation(
    flagKey: string,
    _defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    if (!isFlagKey(flagKey)) throw new FlagNotFoundError(`${flagKey} is not in the catalogue`);
    const parsed = Context.safeParse(context);
    if (!parsed.success) throw new InvalidContextError("tenantId, locationId and overrides");
    const { tenantId, locationId, overrides } = parsed.data;
    const ownRow = overrides.some(
      (r) => r.flagKey === flagKey && (r.locationId === null || r.locationId === locationId),
    );
    let remote: boolean | undefined;
    if (this.remote && !ownRow && remoteMaySet(flagKey)) {
      remote = (await this.remote.flagsFor({ tenantId, locationId }))?.get(flagKey);
    }
    const { enabled, source } = resolveFlag(flagKey, overrides, locationId, remote);
    return {
      value: enabled,
      variant: source,
      reason:
        source === "catalogue"
          ? StandardResolutionReasons.DEFAULT
          : StandardResolutionReasons.TARGETING_MATCH,
    };
  }

  resolveStringEvaluation(): Promise<ResolutionDetails<string>> {
    return Promise.reject(new TypeMismatchError("Catalogue flags are booleans"));
  }

  resolveNumberEvaluation(): Promise<ResolutionDetails<number>> {
    return Promise.reject(new TypeMismatchError("Catalogue flags are booleans"));
  }

  resolveObjectEvaluation<T extends JsonValue>(): Promise<ResolutionDetails<T>> {
    return Promise.reject(new TypeMismatchError("Catalogue flags are booleans"));
  }
}

export interface FlagInput {
  readonly tenantId: string;
  /** The location evaluated at, or null for the organisation as a whole. */
  readonly locationId: string | null;
  /** The organisation's `feature_flag` rows that are not deleted. */
  readonly overrides: readonly FlagRow[];
}

export interface FlagService {
  /** Every catalogue flag for the organisation, through the OpenFeature client. */
  evaluateAll(input: FlagInput): Promise<Record<FlagKey, boolean>>;
}

/** The OpenFeature domain Harbour's API evaluates in. */
export const FLAG_DOMAIN = "harbour";

/**
 * Registers the provider (with Flagsmith only when its key is set) and returns the evaluator.
 * When the provider fails, the client answers the catalogue default with AI off.
 */
export function createFlagService(
  config: Config,
  logger: Logger,
  domain: string = FLAG_DOMAIN,
  remote: RemoteFlags | null = config.FLAGSMITH_ENVIRONMENT_KEY
    ? new FlagsmithFlags(
        {
          apiUrl: config.FLAGSMITH_API_URL,
          environmentKey: config.FLAGSMITH_ENVIRONMENT_KEY,
          timeoutMs: config.FLAGSMITH_TIMEOUT_MS,
          cacheSeconds: config.FLAGSMITH_CACHE_SECONDS,
        },
        logger,
      )
    : null,
): FlagService {
  OpenFeature.setProvider(domain, new HarbourFlagProvider(remote));
  const client = OpenFeature.getClient(domain);
  const keys = Object.keys(FLAGS) as FlagKey[];
  return {
    async evaluateAll({ tenantId, locationId, overrides }) {
      const context: EvaluationContext = {
        tenantId,
        locationId,
        overrides: overrides.map((r) => ({
          flagKey: r.flagKey,
          locationId: r.locationId,
          enabled: r.enabled,
        })),
      };
      const values = await Promise.all(
        keys.map((key) => client.getBooleanValue(key, resolveFlag(key, [], null).enabled, context)),
      );
      return Object.fromEntries(keys.map((key, i) => [key, values[i] === true])) as Record<
        FlagKey,
        boolean
      >;
    },
  };
}

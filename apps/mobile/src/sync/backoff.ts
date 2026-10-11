/**
 * Exponential backoff with full jitter, used by the PowerSync upload connector so a flaky network
 * does not hammer the API and a long outage does not lose writes (they stay queued on the device).
 */

export interface BackoffPolicy {
  /** First retry waits up to this long. */
  readonly baseDelayMs: number;
  /** No single wait exceeds this. */
  readonly maxDelayMs: number;
  /** Total attempts including the first. */
  readonly maxAttempts: number;
}

export const UPLOAD_BACKOFF: BackoffPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 5,
};

/**
 * Delay before retry number `retry` (0 for the first retry): a uniformly random wait between zero
 * and min(maxDelay, base * 2^retry) ("full jitter").
 */
export function backoffDelay(
  retry: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry));
  return Math.floor(random() * ceiling);
}

export type RetryDecision =
  | { readonly retry: false }
  | { readonly retry: true; readonly afterMs?: number | null };

export interface RetryOptions {
  readonly policy: BackoffPolicy;
  /** Decides whether an error is transient. Non-retryable errors are rethrown at once. */
  readonly classify: (error: unknown) => RetryDecision;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  /** Called before each wait, for logging with opaque identifiers only. */
  readonly onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation` until it succeeds, a non-retryable error occurs or the attempts run out; the
 * last error is rethrown so the caller (PowerSync) keeps the data queued and reports the failure.
 */
export async function retryWithBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { policy, classify } = options;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const decision = classify(error);
      if (!decision.retry || attempt >= policy.maxAttempts) throw error;
      const jittered = backoffDelay(attempt - 1, policy, random);
      const serverHint = decision.afterMs ?? null;
      const delayMs =
        serverHint === null
          ? jittered
          : Math.min(Math.max(serverHint, jittered), policy.maxDelayMs);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

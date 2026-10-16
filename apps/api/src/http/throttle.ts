import { BlockList, isIP } from "node:net";
import { slideWindow } from "./quota";

function trustedList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, bits] = cidr.split("/");
    if (!address || isIP(address) === 0) continue;
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) list.addAddress(address, family);
    else list.addSubnet(address, Number(bits), family);
  }
  return list;
}

/**
 * The client address to throttle by (#53 review L2): the right-most X-Forwarded-For entry that is
 * not a trusted proxy (`TRUSTED_PROXY_CIDRS`, as Better Auth reads it), because entries to its left
 * are whatever the client sent. Null when there is none: the caller then counts per token only,
 * never in one bucket every such client would share.
 */
export function throttleAddress(
  forwardedFor: string | undefined,
  trustedCidrs: readonly string[],
): string | null {
  const trusted = trustedList(trustedCidrs);
  const hops = (forwardedFor ?? "").split(",").map((h) => h.trim());
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] ?? "";
    const family = isIP(hop);
    if (family === 0) return null;
    if (!trusted.check(hop, family === 6 ? "ipv6" : "ipv4")) return hop.toLowerCase();
  }
  return null;
}

/**
 * A sliding-window limit for routes with no member to count against (an invitation link opened or
 * accepted before anyone is signed in): kept in this API instance's memory, keyed by an opaque
 * value (a client address, or a token's SHA-256, never the token). Counting across instances needs
 * a Postgres table keyed by something other than a member (`request_quota` is per member), logged
 * in STATUS item 20 for Lane A.
 */
export class MemoryThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    /** Keys kept at most, so a flood of distinct keys cannot grow memory without bound. */
    readonly maxKeys = 10_000,
  ) {}

  /** Records one use of `key` now; seconds to wait when over the limit (nothing recorded), else null. */
  take(key: string, now: number = Date.now()): number | null {
    const previous = (this.hits.get(key) ?? []).map((at) => ({ at, amount: 1 }));
    const { recent, waitSeconds } = slideWindow(previous, 1, this.limit, this.windowMs, now);
    if (waitSeconds !== null) return waitSeconds;
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      // Drop the oldest key (Map keeps insertion order).
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    this.hits.delete(key);
    this.hits.set(key, [...recent.map((h) => h.at), now]);
    return null;
  }
}

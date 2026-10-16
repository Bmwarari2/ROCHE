import { BlockList, isIP } from "node:net";

/**
 * The client address the web passes on to the API (#59 review round 2): the right-most
 * X-Forwarded-For entry that is not a trusted proxy (`TRUSTED_PROXY_CIDRS`), because entries to its
 * left are whatever the client sent. Mirrors `throttleAddress` in apps/api/src/http/throttle.ts,
 * which the API applies again to what arrives. Null when there is none: nothing is forwarded.
 */
export function clientAddress(
  forwardedFor: string | null | undefined,
  trustedCidrs: readonly string[],
): string | null {
  const trusted = new BlockList();
  for (const cidr of trustedCidrs) {
    const [address, bits] = cidr.split("/");
    if (!address || isIP(address) === 0) continue;
    const family = isIP(address) === 6 ? "ipv6" : "ipv4";
    if (bits === undefined) trusted.addAddress(address, family);
    else trusted.addSubnet(address, Number(bits), family);
  }
  const hops = (forwardedFor ?? "").split(",").map((hop) => hop.trim());
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i] ?? "";
    const family = isIP(hop);
    if (family === 0) return null;
    if (!trusted.check(hop, family === 6 ? "ipv6" : "ipv4")) return hop.toLowerCase();
  }
  return null;
}

/** `TRUSTED_PROXY_CIDRS` as a list (comma separated, as the API reads it). */
export function trustedProxies(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((cidr) => cidr.trim())
    .filter(Boolean);
}

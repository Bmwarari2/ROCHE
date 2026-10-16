import { describe, expect, it } from "vitest";
import { clientAddress, trustedProxies } from "./client-address";

describe("clientAddress", () => {
  const proxies = ["10.0.0.0/8", "2001:db8::/32", "192.0.2.10"];
  it.each([
    // The load balancer appends the address it saw; anything to its left came from the client.
    ["198.51.100.7", [], "198.51.100.7"],
    ["203.0.113.1, 198.51.100.7", [], "198.51.100.7"],
    ["203.0.113.1, 198.51.100.7, 10.1.2.3", proxies, "198.51.100.7"],
    ["198.51.100.7, 192.0.2.10", proxies, "198.51.100.7"],
    ["2001:DB8:1::5, 2001:db8::1", proxies, null],
    ["198.51.100.7, 2001:db8::1", proxies, "198.51.100.7"],
    ["2001:DB9::5", proxies, "2001:db9::5"],
    ["10.0.0.1, 10.0.0.2", proxies, null],
    ["not-an-address", [], null],
    ["198.51.100.7, forged", [], null],
    ["", [], null],
    [null, [], null],
  ] as const)("%s with %o is %s", (header, trusted, expected) => {
    expect(clientAddress(header, trusted)).toBe(expected);
  });
});

describe("trustedProxies", () => {
  it("reads the comma-separated list", () => {
    expect(trustedProxies(" 10.0.0.0/8 , ,192.0.2.10")).toEqual(["10.0.0.0/8", "192.0.2.10"]);
    expect(trustedProxies(undefined)).toEqual([]);
  });
});

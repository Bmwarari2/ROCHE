import { describe, expect, it } from "vitest";
import type { FetchLike } from "../auth/http";
import {
  bytesToBase64,
  fetchPersonPhoto,
  MAX_PHOTO_BYTES,
  PhotoMemoryCache,
  photoCacheKey,
} from "./photo";

describe("bytesToBase64", () => {
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
  ])("RFC 4648 vector %j", (input, expected) => {
    expect(bytesToBase64(new TextEncoder().encode(input))).toBe(expected);
  });

  it("encodes longer text and high bytes", () => {
    expect(bytesToBase64(new TextEncoder().encode("Many hands make light work."))).toBe(
      "TWFueSBoYW5kcyBtYWtlIGxpZ2h0IHdvcmsu",
    );
    expect(bytesToBase64(new Uint8Array([0xff, 0xfe, 0xfd, 0x00]))).toBe("//79AA==");
  });
});

describe("PhotoMemoryCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new PhotoMemoryCache(2);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBe("1");
    cache.set("c", "3");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("keys by person and document so a new photo is fetched again", () => {
    expect(photoCacheKey("p1", "d1")).not.toBe(photoCacheKey("p1", "d2"));
  });
});

describe("fetchPersonPhoto", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetchReturning =
    (
      response: Response | Error,
      calls: Array<{ url: string; init?: RequestInit }> = [],
    ): FetchLike =>
    async (url, init) => {
      calls.push({ url, init });
      if (response instanceof Error) throw response;
      return response;
    };
  const base = { apiUrl: "https://api.example.invalid", personId: "p 1", token: "tok" };

  it("returns a data URI and never asks for a cached copy", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await fetchPersonPhoto({
      ...base,
      fetch: fetchReturning(new Response(png, { headers: { "content-type": "image/png" } }), calls),
    });
    expect(result).toBe("data:image/png;base64,iVBORw==");
    expect(calls[0]?.url).toBe("https://api.example.invalid/v1/people/p%201/photo");
    expect(new Headers(calls[0]?.init?.headers).get("cache-control")).toBe("no-store");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it.each([
    ["a 404", new Response("", { status: 404 })],
    ["a non-image", new Response("<html>", { headers: { "content-type": "text/html" } })],
    ["an SVG", new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })],
    [
      "an empty body",
      new Response(new Uint8Array(0), { headers: { "content-type": "image/jpeg" } }),
    ],
    [
      "an oversized photo",
      new Response(new Uint8Array(MAX_PHOTO_BYTES + 1), {
        headers: { "content-type": "image/jpeg" },
      }),
    ],
    ["a network failure", new TypeError("Network request failed")],
  ])("falls back to initials on %s", async (_label, response) => {
    await expect(
      fetchPersonPhoto({ ...base, fetch: fetchReturning(response) }),
    ).resolves.toBeNull();
  });
});

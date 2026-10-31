import { describe, expect, it } from "vitest";
import { readJsonBody } from "./json-body";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit);

/** A body with no Content-Length, as a chunked upload sends it. */
function chunked(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("public JSON bodies with a size cap (#113 review L1)", () => {
  it("reads a small JSON object", async () => {
    expect(await readJsonBody(post('{"token":"abc"}'))).toEqual({
      ok: true,
      body: { token: "abc" },
    });
  });

  it("refuses a declared length over the cap without reading it", async () => {
    expect(await readJsonBody(post("{}", { "content-length": "5000" }), 4096)).toEqual({
      ok: false,
      status: 413,
    });
  });

  it("refuses a chunked body once it passes the cap", async () => {
    const big = chunked(['{"a":"', "x".repeat(3000), "x".repeat(3000), '"}']);
    expect(await readJsonBody(post(big), 4096)).toEqual({ ok: false, status: 413 });
  });

  it.each(["not json", "[1,2]", "null", '"text"'])(
    "refuses %s as not a JSON object",
    async (body) => {
      expect(await readJsonBody(post(body))).toEqual({ ok: false, status: 400 });
    },
  );
});

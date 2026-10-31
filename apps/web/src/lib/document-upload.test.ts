import { describe, expect, it } from "vitest";
import {
  checkUploadRequest,
  countingStream,
  readUploadTarget,
  UPLOAD_MAX_BYTES,
  UploadTooLarge,
  webOrigin,
} from "./document-upload";
import { t } from "./i18n";

const SITE = "https://app.example.invalid";
const ok = { origin: SITE, contentType: "application/pdf", contentLength: "1000" };

describe("the document upload route (PLAT-009; ASVS L2 input limits)", () => {
  it("takes the site's origin from configuration only", () => {
    expect(webOrigin({ PUBLIC_WEB_URL: SITE, NODE_ENV: "production" })).toBe(SITE);
    expect(webOrigin({ NODE_ENV: "production" })).toBeNull();
    expect(webOrigin({ NODE_ENV: "development" })).toBe("http://localhost:3000");
  });

  it("reads a PDF of a stated length within the limit, posted from this site", () => {
    expect(checkUploadRequest(ok, SITE, t)).toBeNull();
    expect(
      checkUploadRequest({ ...ok, contentType: "application/pdf; charset=binary" }, SITE, t),
    ).toBeNull();
    expect(
      checkUploadRequest({ ...ok, contentLength: String(UPLOAD_MAX_BYTES) }, SITE, t),
    ).toBeNull();
  });

  it.each([
    ["another site", { ...ok, origin: "https://evil.example.invalid" }],
    ["no origin", { ...ok, origin: null }],
    ["a look-alike origin", { ...ok, origin: `${SITE}.evil.example.invalid` }],
  ])("refuses %s as forbidden, as a server action would", (_name, request) => {
    expect(checkUploadRequest(request, SITE, t)).toMatchObject({
      status: 403,
      answer: { ok: false, code: "forbidden" },
    });
  });

  it("refuses everything when no origin is configured in production", () => {
    expect(checkUploadRequest(ok, null, t)?.status).toBe(403);
  });

  it.each([["image/jpeg"], ["text/html"], [null], ["multipart/form-data; boundary=x"]])(
    "refuses a %s body: organisation documents are PDFs",
    (contentType) => {
      expect(checkUploadRequest({ ...ok, contentType }, SITE, t)).toMatchObject({
        status: 415,
        answer: { fields: { file: expect.stringContaining("PDF") } },
      });
    },
  );

  it.each([[null], ["0"], ["-1"], ["abc"], ["1.5"]])(
    "refuses a body whose length is %s before reading it",
    (contentLength) => {
      expect(checkUploadRequest({ ...ok, contentLength }, SITE, t)?.status).toBe(411);
    },
  );

  it("refuses a body over the API's document limit before reading it", () => {
    expect(
      checkUploadRequest({ ...ok, contentLength: String(UPLOAD_MAX_BYTES + 1) }, SITE, t),
    ).toMatchObject({
      status: 413,
      answer: { code: "too_large", fields: { file: "Choose a file of 25 MB or less." } },
    });
  });

  it("stops a body that grows past the limit while it streams, whatever its length said", async () => {
    const chunks = [new Uint8Array(6), new Uint8Array(6)];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const reader = source.pipeThrough(countingStream(10)).getReader();
    expect((await reader.read()).value?.byteLength).toBe(6);
    await expect(reader.read()).rejects.toBeInstanceOf(UploadTooLarge);
  });

  it("passes a body within the limit through untouched", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const out = await new Response(source.pipeThrough(countingStream(3))).arrayBuffer();
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3]);
  });

  it("reads a new document's title and file name, or the document a version belongs to", () => {
    expect(
      readUploadTarget(
        new URLSearchParams({ title: " Fire  policy ", fileName: "C:\\x\\fire.pdf" }),
        t,
      ),
    ).toEqual({ ok: true, target: { kind: "new", title: "Fire policy", fileName: "fire.pdf" } });
    const id = "0194d000-0000-7000-8000-00000000000a";
    expect(readUploadTarget(new URLSearchParams({ versionOf: id }), t)).toEqual({
      ok: true,
      target: { kind: "version", id },
    });
    expect(readUploadTarget(new URLSearchParams({ versionOf: "nope" }), t)).toMatchObject({
      ok: false,
      refusal: { status: 404 },
    });
    expect(readUploadTarget(new URLSearchParams({ title: "x" }), t)).toMatchObject({
      ok: false,
      refusal: { status: 400, answer: { fields: { title: expect.any(String) } } },
    });
  });
});

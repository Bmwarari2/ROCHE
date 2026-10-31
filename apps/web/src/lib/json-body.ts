/**
 * Reads a public route's JSON body with a size cap (#113 security review L1): a declared
 * Content-Length over the cap is refused at once, and the stream is read with a byte count, so a
 * chunked body with no length cannot grow without limit. The public pages' bodies are a token, a
 * code, a name and a password: a few hundred bytes.
 */

export const PUBLIC_BODY_MAX_BYTES = 4096;

export type JsonBodyRead =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  /** 413 when too large, 400 when not a JSON object. */
  | { readonly ok: false; readonly status: 400 | 413 };

export async function readJsonBody(
  request: Request,
  maxBytes: number = PUBLIC_BODY_MAX_BYTES,
): Promise<JsonBodyRead> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? { ok: true, body: body as Record<string, unknown> }
      : { ok: false, status: 400 };
  } catch {
    return { ok: false, status: 400 };
  }
}

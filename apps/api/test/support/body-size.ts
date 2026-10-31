import { withAdminClient } from "@harbour/db/testing";
import type { Harness } from "./harness";

/**
 * Helpers for the body caps on routes reached with no session (security review, 31 October 2026):
 * a JSON body of an exact size, and the audit rows a request id left anywhere in the database.
 */

/** A JSON object of exactly `bytes` bytes: the fields given, padded with one more field. */
export function jsonOfSize(fields: Record<string, unknown>, bytes: number): Uint8Array {
  const base = JSON.stringify({ ...fields, pad: "" });
  if (bytes < base.length) throw new Error("The fields alone are larger than the size asked for");
  return new TextEncoder().encode(
    JSON.stringify({ ...fields, pad: "x".repeat(bytes - base.length) }),
  );
}

/**
 * Posts a JSON body of exactly `bytes` bytes, streamed with no declared length (as a chunked body
 * arrives) or, with `declared`, with its Content-Length.
 */
export function postSized(
  h: Harness,
  path: string,
  fields: Record<string, unknown>,
  bytes: number,
  requestId: string,
  declared = false,
): Promise<Response> {
  return h.request(path, {
    method: "POST",
    raw: { bytes: jsonOfSize(fields, bytes), contentType: "application/json" },
    headers: {
      "x-request-id": requestId,
      ...(declared ? { "content-length": String(bytes) } : {}),
    },
  });
}

/** Audit rows of any organisation, or none, written under these request ids (read as superuser). */
export async function auditRowsFor(h: Harness, requestIds: readonly string[]): Promise<number> {
  return withAdminClient(async (client) => {
    const { rows } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_event WHERE request_id = ANY($1::text[])",
      [requestIds],
    );
    return rows[0]?.n ?? 0;
  }, h.db.name);
}

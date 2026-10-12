import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * An organisation's policy document, fetched from the API for the active organisation and
 * streamed to the browser, so a validated tool's result can link the escalation policy it names
 * (medical-device boundary rule 4; HZ-012, HZ-014). PDF only, as organisation documents are,
 * downloaded rather than shown inline, never cached; the API audits every read and refuses a
 * document the reader may not see. The browser never reaches the API's /v1 routes itself.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response } = await api.GET("/v1/documents/{id}/content", {
    params: { path: { id } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    return new Response(null, { status: 404, headers: noStore });
  }
  const disposition = response.headers.get("content-disposition") ?? "attachment";
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": type,
      "content-disposition": disposition.startsWith("inline")
        ? disposition.replace(/^inline/, "attachment")
        : disposition,
      "x-content-type-options": "nosniff",
    },
  });
}

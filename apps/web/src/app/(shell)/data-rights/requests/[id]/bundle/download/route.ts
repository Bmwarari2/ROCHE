import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { bundlePage, requestPage } from "@/lib/dsar";
import { redirectForProblem } from "@/lib/problems";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The response bundle as a file to send (PLAT-022; the DSAR workbench rule 5): the bundle as it
 * would be sent, or with `?issued=1` exactly as it was sent. Fetched from the API for the active
 * organisation and passed to the browser, never kept; the API needs a fresh step-up and audits
 * the read. A refusal goes to signing in again or back to the request.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const issued = new URL(request.url).searchParams.get("issued") === "1";
  const api = await tenantApi();
  const options = { params: { path: { id } }, parseAs: "text", signal: request.signal } as const;
  const { response, data, error } = issued
    ? await api.GET("/v1/dsar-cases/{id}/bundle/issued", options)
    : await api.GET("/v1/dsar-cases/{id}/bundle", options);
  if (!response.ok || typeof data !== "string") {
    // A refusal is a small problem document: read its code only.
    const problem = ((): { code?: string } | null => {
      if (typeof error === "object" && error !== null) return error as { code?: string };
      try {
        return JSON.parse(String(error ?? "")) as { code?: string };
      } catch {
        return null;
      }
    })();
    const back = issued ? requestPage(id) : bundlePage(id);
    redirect(redirectForProblem(problem?.code, back) ?? back);
  }
  return new Response(data, {
    headers: {
      ...noStore,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="subject-access-${id}${issued ? "-sent" : ""}.json"`,
      "x-content-type-options": "nosniff",
    },
  });
}

import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { downloadFailureTarget } from "@/lib/exports";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The export's archive (PLAT-015; HZ-070), fetched once from the API for the active organisation
 * and streamed to the browser as a download, never kept: the web app stores nothing and the
 * browser is told not to cache it. The API needs a fresh step-up and the requester; it records the
 * single fetch before the bytes leave. A refusal goes to signing in again or back to the page.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response } = await api.GET("/v1/exports/{id}/download", {
    params: { path: { id } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/zip" || !response.body) {
    const problem = (await new Response(response.body).json().catch(() => null)) as {
      code?: string;
    } | null;
    redirect(downloadFailureTarget(problem?.code));
  }
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="harbour-export-${id}.zip"`,
      "x-content-type-options": "nosniff",
    },
  });
}

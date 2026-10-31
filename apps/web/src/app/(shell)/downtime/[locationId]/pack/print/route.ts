import { redirect } from "next/navigation";
import { problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { printFailureTarget } from "@/lib/downtime";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The printed downtime pack (operations.md section 13, part 3a-2; HZ-021), fetched from the API
 * for the active organisation and streamed to the browser as a download, never kept: the web app
 * stores nothing and the browser is told not to cache it. The API needs a fresh sign-in (a
 * whole-home record), counts the request against the hourly limit and audits the print; when it
 * gives no PDF, the person goes where they can act: to sign in again, or back to the location's
 * page with what happened in words.
 */
export async function GET(_request: Request, context: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await context.params;
  if (!isUuid(locationId)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response, error } = await api.GET("/v1/locations/{id}/downtime-pack", {
    params: { path: { id: locationId }, query: { format: "pdf" } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    redirect(
      printFailureTarget(
        locationId,
        response.status,
        problemCode(error),
        response.headers.get("retry-after"),
      ),
    );
  }
  const disposition = response.headers.get("content-disposition") ?? "attachment";
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/pdf",
      "content-disposition": disposition.startsWith("inline")
        ? disposition.replace(/^inline/, "attachment")
        : disposition,
      "x-content-type-options": "nosniff",
    },
  });
}

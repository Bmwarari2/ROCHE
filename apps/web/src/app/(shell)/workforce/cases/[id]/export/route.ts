import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * An employee relations case as its case manager takes it with them (H-805): fetched from the API
 * as the signed-in person and streamed to the browser as a download, never kept. The API checks
 * that the person is the case's case manager, asks for a fresh step-up and audits the export.
 * Without step-up, the person signs in again and comes back here; otherwise the case page says
 * the export did not happen.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const here = `/workforce/cases/${id}/export`;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/workforce/cases/{id}/export", {
    params: { path: { id } },
  });
  if (!data) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "step_up_required" || code === "mfa_verification_required") {
      redirect(`/sign-in?${new URLSearchParams({ reason: "step-up", next: here }).toString()}`);
    }
    redirect(`/workforce/cases/${id}?export=${response.status === 403 ? "refused" : "failed"}`);
  }
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      ...noStore,
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="employee-case-${id}.json"`,
      "x-content-type-options": "nosniff",
    },
  });
}

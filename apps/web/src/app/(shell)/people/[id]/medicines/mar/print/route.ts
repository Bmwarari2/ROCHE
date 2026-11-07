import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { medicinesHref } from "@/lib/medicines";

const noStore = { "cache-control": "private, no-store" } as const;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * The MAR chart for a month, to print (slice 50; MEDS-014; medicines.md section 17). Fetched from the
 * API as the signed-in person and streamed to the browser as a download, never kept. The API checks
 * the permission and audits the print; every page says when it was printed and that it is not the
 * live record (HZ-122). When it gives no PDF, the person goes back to the Medicines tab, which says
 * so in words.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const month = new URL(request.url).searchParams.get("month") ?? "";
  if (!isUuid(id) || !MONTH.test(month)) {
    return new Response(null, { status: 404, headers: noStore });
  }
  const api = await tenantApi();
  const { response } = await api.GET("/v1/people/{id}/mar/print", {
    params: { path: { id }, query: { month } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    // Free the connection to the API before leaving (security review of slice 50).
    await response.body?.cancel();
    redirect(`${medicinesHref(id)}?print=failed`);
  }
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="mar-${month}.pdf"`,
      "x-content-type-options": "nosniff",
    },
  });
}

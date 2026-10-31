import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The hospital transfer pack as sent, to print (people.md rule 10 and section 6a; PEOP-009; HZ-001,
 * HZ-023). Fetched from the API as the signed-in person and streamed to the browser as a download,
 * never kept: the web app stores nothing and the browser is told not to cache it. The API checks
 * `people.movement.record`, counts the request against the pack limit and audits the print with
 * its recipient. When it gives no PDF, the person goes back to the hospital tab, which says so in
 * words (too many packs in a minute, or try again).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; transferId: string }> },
) {
  const { id, transferId } = await context.params;
  if (!isUuid(id) || !isUuid(transferId)) {
    return new Response(null, { status: 404, headers: noStore });
  }
  const api = await tenantApi();
  const { response } = await api.GET("/v1/people/{id}/hospital-transfers/{transferId}/pdf", {
    params: { path: { id, transferId } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    const reason = response.status === 429 ? "busy" : "failed";
    redirect(`${tabHref(id, "hospital")}?print=${reason}`);
  }
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="transfer-pack-${transferId}.pdf"`,
      "x-content-type-options": "nosniff",
    },
  });
}

import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { certificateHref } from "@/lib/shred";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * A destruction certificate as a PDF (PLAT-012 part 2; platform.md rule 12). Built by the API on
 * request from the signed record, checked as it is built, and streamed to the browser as a
 * download, never kept: the web app stores nothing and the browser is told not to cache it. The
 * API checks `platform.retention.manage` and audits the download. When it gives no PDF, the person
 * goes back to the certificate, which says so in words.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response } = await api.GET("/v1/destruction-certificates/{id}/pdf", {
    params: { path: { id } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    redirect(`${certificateHref(id)}?pdf=failed`);
  }
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="destruction-certificate-${id}.pdf"`,
      "x-content-type-options": "nosniff",
    },
  });
}

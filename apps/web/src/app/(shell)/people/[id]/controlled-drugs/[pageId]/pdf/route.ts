import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * A controlled drugs register page as a PDF (slice 50; MEDS-014; H-1331), streamed from the API as
 * the signed-in person and never kept. The API checks the permission and audits the print; every page
 * says when it was printed and that it is not the live record (HZ-122).
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string; pageId: string }> },
) {
  const { id, pageId } = await context.params;
  if (!isUuid(id) || !isUuid(pageId)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response } = await api.GET("/v1/controlled-drugs/pages/{pageId}/print", {
    params: { path: { pageId } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    redirect(`/people/${id}/controlled-drugs/${pageId}?print=failed`);
  }
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="cd-register-${pageId}.pdf"`,
      "x-content-type-options": "nosniff",
    },
  });
}

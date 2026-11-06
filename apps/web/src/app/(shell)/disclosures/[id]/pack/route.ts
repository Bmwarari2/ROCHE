import { redirect } from "next/navigation";
import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The released disclosure pack as a PDF, downloaded once (H-958, recommended answer applied
 * 31/10/2026). Fetched from the API as the signed-in person and streamed to the browser, never
 * kept: the web app stores nothing and the browser is told not to cache it. The API checks the
 * permission where the person is, a fresh second factor, that the pack still matches its
 * fingerprint and that it has not been downloaded before, and audits the download. When it gives
 * no PDF, the person goes back to the request, which says why in words.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response } = await api.GET("/v1/disclosures/{id}/pack/pdf", {
    params: { path: { id } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || type !== "application/pdf" || !response.body) {
    const reason =
      response.status === 403 ? "step-up" : response.status === 409 ? "already" : "failed";
    redirect(`/disclosures/${id}?download=${reason}`);
  }
  return new Response(response.body, {
    headers: {
      ...noStore,
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="disclosure-pack-${id}.pdf"`,
      "x-content-type-options": "nosniff",
    },
  });
}

import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The person's photo, fetched from the API for the active organisation and streamed to the
 * browser. Never cached: a photo is personal data.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { response } = await api.GET("/v1/people/{id}/photo", {
    params: { path: { id } },
    parseAs: "stream",
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || !IMAGE_TYPES.has(type) || !response.body) {
    return new Response(null, { status: 404, headers: noStore });
  }
  return new Response(response.body, {
    headers: { ...noStore, "content-type": type, "x-content-type-options": "nosniff" },
  });
}

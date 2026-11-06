import { tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * A destruction certificate's signature check as data (PLAT-012 part 2; platform.md rule 11): the
 * API's `GET /v1/destruction-certificates/{id}/verification`, as the signed-in person, passed on
 * unchanged (the exact body that was signed, the signature, the key and whether it verifies), so
 * anyone checking it with Harbour's published key works from what Harbour returned.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isUuid(id)) return new Response(null, { status: 404, headers: noStore });
  const api = await tenantApi();
  const { data, response } = await api.GET("/v1/destruction-certificates/{id}/verification", {
    params: { path: { id } },
  });
  if (!data) return new Response(null, { status: response.status, headers: noStore });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      ...noStore,
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

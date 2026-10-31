import { getShellContext, tenantApi } from "@/lib/api";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

const noStore = { "cache-control": "private, no-store" } as const;

/**
 * The active organisation's white-label logo (PLAT-002), fetched from the API and streamed to the
 * browser for the app bar. About no one, so the browser may keep it for an hour; the shell's
 * address changes with the logo (`?v=` the document id), so a new one is fetched at once. The bytes
 * are served only when `v` names the active organisation's logo now, so an address can never be
 * cached holding another organisation's logo after a switch in another tab (security review).
 * Images only, `nosniff`, never SVG.
 */
export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams.get("v");
  const { me } = await getShellContext();
  if (!asked || asked !== me.tenant.logoDocumentId) {
    return new Response(null, { status: 404, headers: noStore });
  }
  const api = await tenantApi();
  const { response } = await api.GET("/v1/branding/logo", { parseAs: "stream" });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || !IMAGE_TYPES.has(type) || !response.body) {
    return new Response(null, { status: 404, headers: noStore });
  }
  return new Response(response.body, {
    headers: {
      "cache-control": "private, max-age=3600",
      vary: "Cookie",
      "content-type": type,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

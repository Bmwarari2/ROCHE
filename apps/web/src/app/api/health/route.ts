/**
 * Load balancer health check (infra/modules/harbour_stack: web_health_check_path). Answers from
 * the web tier alone: no API call, no personal data.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
}

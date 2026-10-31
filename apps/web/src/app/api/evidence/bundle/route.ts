import { openBundle } from "@/lib/evidence-link-server";

export function GET(request: Request): Promise<Response> {
  return openBundle(request);
}

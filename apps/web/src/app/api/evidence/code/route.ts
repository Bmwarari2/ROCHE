import { sendCode } from "@/lib/evidence-link-server";

export function POST(request: Request): Promise<Response> {
  return sendCode(request);
}

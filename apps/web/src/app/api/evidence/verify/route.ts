import { verifyCode } from "@/lib/evidence-link-server";

export function POST(request: Request): Promise<Response> {
  return verifyCode(request);
}

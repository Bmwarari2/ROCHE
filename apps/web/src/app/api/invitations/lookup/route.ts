import { lookupInvitation } from "@/lib/invitation-server";
import { invitationRequest, text } from "../handler";

export function POST(request: Request): Promise<Response> {
  return invitationRequest(request, (body) => lookupInvitation(text(body.token) ?? ""));
}

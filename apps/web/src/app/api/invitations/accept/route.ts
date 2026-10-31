import { acceptInvitation } from "@/lib/invitation-server";
import { invitationRequest, text } from "../handler";

export function POST(request: Request): Promise<Response> {
  return invitationRequest(request, (body) => {
    const name = text(body.name);
    const password = text(body.password);
    return acceptInvitation({
      token: text(body.token) ?? "",
      ...(name !== undefined ? { name } : {}),
      ...(password !== undefined ? { password } : {}),
    });
  });
}

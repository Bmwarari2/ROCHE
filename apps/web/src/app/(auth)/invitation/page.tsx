import type { Metadata } from "next";
import { connection } from "next/server";
import { t } from "@/lib/i18n";
import { InvitationAccept } from "./InvitationAccept";

export const metadata: Metadata = {
  title: t("invitation.pageTitle"),
  // The link is personal: keep it out of search engines and never send it on as a Referer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The page an invitation email links to (`/invitation#<token>`). The token is in the fragment, so
 * the server never sees it in the URL; the client component reads it (PLAT-004).
 */
export default async function InvitationPage() {
  // Rendered per request, so the page carries this request's CSP nonce.
  await connection();
  return (
    <>
      <h1 className="m-0 text-title">{t("invitation.title")}</h1>
      <InvitationAccept />
    </>
  );
}

import type { Metadata } from "next";
import { connection } from "next/server";
import { t } from "@/lib/i18n";
import { EvidenceOpen } from "./EvidenceOpen";

export const metadata: Metadata = {
  // Never a person, recipient or pack in the title.
  title: t("evidenceLink.pageTitle"),
  // The link is personal: keep it out of search engines and never send it on as a Referer.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The page an evidence pack link opens (`/evidence#<token>`; QUAL-003; HZ-050; ADR-0050). The
 * token is in the fragment, so no server sees it in the URL; the client component reads it, asks
 * for a code by email and opens the pack. Signed out, no product shell.
 */
export default async function EvidencePage() {
  // Rendered per request, so the page carries this request's CSP nonce.
  await connection();
  return (
    <>
      <h1 className="m-0 text-title">{t("evidenceLink.title")}</h1>
      <EvidenceOpen />
    </>
  );
}

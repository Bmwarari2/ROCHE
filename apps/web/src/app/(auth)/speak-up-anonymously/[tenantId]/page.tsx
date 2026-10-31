import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { AnonymousSpeakUp } from "@/components/safety-silos/AnonymousSpeakUp";
import { t } from "@/lib/i18n";
import { isOrganisationId } from "@/lib/speak-up";

export const metadata: Metadata = {
  title: t("speakUp.anonymous.pageTitle"),
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Raising a concern anonymously (SAFE-012; ADR-0089): no sign-in and no product shell. The page
 * says plainly what anonymous means here before anything is written. It sets no cookie and keeps
 * nothing in the browser; the organisation is in the address only so the concern reaches it.
 */
export default async function AnonymousSpeakUpPage({
  params,
}: {
  params: Promise<{ tenantId: string }>;
}) {
  await connection();
  const { tenantId } = await params;
  if (!isOrganisationId(tenantId)) notFound();
  return (
    <>
      <h1 className="m-0 text-title">{t("speakUp.anonymous.title")}</h1>
      <section aria-labelledby="what-anonymous-means" className="flex flex-col gap-3">
        <h2 id="what-anonymous-means" className="m-0 text-heading">
          {t("speakUp.anonymous.meansTitle")}
        </h2>
        <ul className="m-0 flex flex-col gap-2 pl-5">
          <li>{t("speakUp.anonymous.meansNoName")}</li>
          <li>{t("speakUp.anonymous.meansNoTrace")}</li>
          <li>{t("speakUp.anonymous.meansWords")}</li>
          <li>{t("speakUp.anonymous.meansToken")}</li>
          <li>{t("speakUp.anonymous.meansWho")}</li>
        </ul>
        <p className="m-0">{t("speakUp.anonymous.elsewhere")}</p>
      </section>
      <AnonymousSpeakUp tenantId={tenantId} />
    </>
  );
}

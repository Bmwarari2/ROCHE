import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { NewPolicyForm } from "@/components/quality/PolicyForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { policiesManaged } from "@/lib/policies";

export const metadata: Metadata = { title: t("quality.policies.new.title") };

/**
 * A new policy (QUAL-008; rule 25) with its first draft: a major version, the text or an
 * organisation document, who must read and sign it and when it is reviewed. It is published later,
 * by someone else where it needs a second reviewer.
 */
export default async function NewPolicyPage() {
  const { me } = await getShellContext();
  const title = t("quality.policies.new.title");
  if (!policiesManaged(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const documents =
    (
      await api.GET("/v1/documents", { params: { query: { category: "organisation_document" } } })
    ).data?.items.filter((d) => d.status === "available") ?? [];

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.policies.new.description")} />
      <p className="m-0">
        <Link href="/policies" className="inline-flex min-h-target items-center underline">
          {t("quality.policies.back")}
        </Link>
      </p>
      <Card as="section" title={t("quality.policies.new.cardTitle")} headingLevel={2}>
        <NewPolicyForm documents={documents.map((d) => ({ id: d.id, title: d.title }))} />
      </Card>
    </div>
  );
}

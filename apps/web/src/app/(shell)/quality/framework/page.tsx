import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";
import { frameworkShown, versionChip } from "@/lib/quality-programme";

export const metadata: Metadata = { title: t("quality.framework.title") };

/**
 * The compliance framework (QUAL-001; quality.md sections 18 and 20): every version, the one in
 * force today marked with an icon and a word, each opening its key questions and statements.
 */
export default async function FrameworkPage() {
  const { me } = await getShellContext();
  const title = t("quality.framework.title");
  if (!frameworkShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const list = readOrFail(await api.GET("/v1/quality/frameworks"), "/quality/framework");
  if (!list) return <SafetyForbidden title={title} />;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader title={title} description={t("quality.framework.description")} />
      <Card as="section" title={t("quality.framework.versions")} headingLevel={2}>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {list.items.map((version) => {
            const about = `framework-${version.id}`;
            return (
              <li key={version.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link
                    href={`/quality/framework/${version.id}`}
                    aria-describedby={about}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {t("quality.framework.versionTitle", {
                      regulator: version.regulator,
                      version: version.versionNumber,
                    })}
                  </Link>
                </h3>
                <span>
                  <QualityChip chip={versionChip(version, t)} />
                </span>
                <span id={about} className="text-body-dense text-text-secondary">
                  {t("quality.framework.published", {
                    date: formatDate(version.publishedOn) ?? "",
                    hasDate: String(version.publishedOn !== null),
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

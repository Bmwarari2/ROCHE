import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { FileUp } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ImportUpload } from "@/components/imports/ImportUpload";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { IMPORT_PAGE, importChip, importPage, importShown } from "@/lib/imports";

export const metadata: Metadata = { title: t("import.title") };

/**
 * The import wizard (PLAT-014; platform.md rules 18 to 26; ADR-0092; HZ-130), for members who
 * hold platform.import.run, people.person.create and people.person.read across the organisation:
 * upload a CSV of people for one home and match its columns, then check, commit and (while it is
 * available) undo it on the import's own page. Earlier imports are listed with where each stands,
 * as an icon and a word.
 */
export default async function ImportPage() {
  const { me } = await getShellContext();
  const title = t("import.title");
  if (!importShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/imports");
  if (!listed.data) failWith(listed.error, listed.response, IMPORT_PAGE);
  const items = listed.data.items;
  const homes = new Map(me.locations.map((l) => [l.id, l.name]));
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("import.description")} />
      <Card as="section" title={t("import.upload.title")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose">{t("import.upload.about")}</p>
          <ImportUpload locations={me.locations.map((l) => ({ id: l.id, name: l.name }))} />
        </div>
      </Card>
      <Card as="section" title={t("import.list.title")} headingLevel={2}>
        {items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FileUp size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("import.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {items.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link href={importPage(item.id)}>
                    {t("import.item.title", {
                      rows: item.rows,
                      known: homes.has(item.locationId) ? "yes" : "no",
                      home: homes.get(item.locationId) ?? "",
                      dateTime: when(item.uploadedAt),
                    })}
                  </Link>
                </h3>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <SafetyChip chip={importChip(item.status, t)} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

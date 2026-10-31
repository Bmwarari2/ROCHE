import { buttonClassName, Card, EmptyState, PageHeader } from "@harbour/ui";
import { FolderLock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { QualityChip } from "@/components/quality/QualityChip";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, tenantApi } from "@/lib/api";
import { COMPOSE, evidencePacksShown, packStateChip } from "@/lib/evidence-packs";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { readOrFail } from "@/lib/person-record";

export const metadata: Metadata = { title: t("quality.packs.title") };

/**
 * Inspector evidence packs (QUAL-003; quality.md section 16; HZ-050): every pack the reader can
 * see, newest first, each with who it is for, why, its dates and its state as an icon and a word.
 */
export default async function EvidencePacksPage() {
  const { me } = await getShellContext();
  const title = t("quality.packs.title");
  if (!evidencePacksShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const list = readOrFail(await api.GET("/v1/evidence-packs"), "/quality/evidence-packs");
  if (!list) return <SafetyForbidden title={title} />;
  const compose = me.permissions.includes(COMPOSE);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <PageHeader
        title={title}
        description={t("quality.packs.description")}
        {...(compose
          ? {
              primaryAction: (
                <Link
                  href="/quality/evidence-packs/new"
                  className={buttonClassName({ variant: "primary" })}
                >
                  {t("quality.packs.compose")}
                </Link>
              ),
            }
          : {})}
      />
      {list.items.length === 0 ? (
        <EmptyState
          icon={<FolderLock size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.packs.empty")}
          description={t("quality.packs.emptyHint")}
        />
      ) : (
        <Card as="section" title={t("quality.packs.listTitle")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {list.items.map((pack) => {
              const about = `pack-${pack.id}`;
              return (
                <li key={pack.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <h3 className="m-0 text-body font-semibold">
                    <Link
                      href={`/quality/evidence-packs/${pack.id}`}
                      aria-describedby={about}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("quality.packs.itemTitle", {
                        name: pack.recipientName,
                        organisation: pack.recipientOrganisation,
                      })}
                    </Link>
                  </h3>
                  <span>
                    <QualityChip chip={packStateChip(pack.state, t)} />
                  </span>
                  <div id={about} className="flex flex-col gap-1">
                    <span>{pack.purpose}</span>
                    <span className="text-body-dense text-text-secondary">
                      {t("quality.pack.dates", {
                        from: formatDate(pack.from) ?? "",
                        to: formatDate(pack.to) ?? "",
                      })}
                    </span>
                    <span className="text-body-dense text-text-secondary">
                      {t("quality.packs.made", {
                        composed: formatDateTime(pack.composedAt) ?? "",
                        released: formatDateTime(pack.releasedAt) ?? "",
                        hasReleased: String(pack.releasedAt !== null),
                      })}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}

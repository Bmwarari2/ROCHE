import { ButtonLink, Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { Lock, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Notice } from "@/components/care/Notice";
import { RequestShredForm } from "@/components/retention/ShredForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { RETENTION_PAGE, retentionShown, splitHolds } from "@/lib/retention";
import { memberName, openRequest, SHRED_PAGE, shredChip, shredHref, shredState } from "@/lib/shred";

export const metadata: Metadata = { title: t("shred.title") };

/**
 * Shredding the whole organisation's records (PLAT-012 part 2; platform.md rules 7 and 10;
 * ADR-0109), for tenant-wide holders of `platform.retention.manage`. What a shred does comes first,
 * in plain words; legal holds in force stop it and are listed; the request form offers only full
 * exports downloaded within 30 days; and every request is listed with its state as an icon and a
 * word. The API decides every rule again.
 */
export default async function ShredPage() {
  const { me } = await getShellContext();
  const title = t("shred.title");
  if (!retentionShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [requests, holds, exports] = await Promise.all([
    api.GET("/v1/retention/shred-requests"),
    api.GET("/v1/legal-holds"),
    api.GET("/v1/retention/shred-exports"),
  ]);
  if (!requests.data) failWith(requests.error, requests.response, SHRED_PAGE);
  if (!holds.data) failWith(holds.error, holds.response, SHRED_PAGE);
  const { inForce } = splitHolds(holds.data.items);
  if (!exports.data) failWith(exports.error, exports.response, SHRED_PAGE);
  const usable = exports.data.items;
  const open = openRequest(requests.data.items);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("shred.description")} />
      <Card as="section" title={t("shred.what.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 flex items-center gap-2 font-semibold">
            <TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />
            {t("shred.what.cannotUndo")}
          </p>
          <ul className="m-0 flex max-w-prose flex-col gap-2 pl-5">
            <li>{t("shred.what.objects")}</li>
            <li>{t("shred.what.keys")}</li>
            <li>{t("shred.what.rows")}</li>
            <li>{t("shred.what.backups")}</li>
            <li>{t("shred.what.twoPeople")}</li>
          </ul>
        </div>
      </Card>
      {inForce.length > 0 ? (
        <Card as="section" title={t("shred.holds.title")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0">{t("shred.holds.blocked", { count: inForce.length })}</p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {inForce.map((hold) => (
                <li key={hold.id} className="flex flex-wrap items-center gap-2">
                  <StatusChip status="info" label={t("retention.holds.inForce")} icon={Lock} />
                  <span>
                    {t("shred.holds.item", { when: when(hold.placedAt), reason: hold.reason })}
                  </span>
                </li>
              ))}
            </ul>
            <p className="m-0">
              <Link
                href={RETENTION_PAGE}
                className="inline-flex min-h-target items-center underline"
              >
                {t("shred.holds.link")}
              </Link>
            </p>
          </div>
        </Card>
      ) : null}
      <Card as="section" title={t("shred.request.title")} headingLevel={2}>
        {open ? (
          <p className="m-0">
            <Link
              href={shredHref(open.id)}
              className="inline-flex min-h-target items-center underline"
            >
              {t("shred.request.open")}
            </Link>
          </p>
        ) : inForce.length > 0 ? (
          <p className="m-0">{t("shred.request.heldBack")}</p>
        ) : usable.length === 0 ? (
          <div className="flex flex-col gap-3">
            <Notice
              tone="warning"
              icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("shred.request.noExport")}
            />
            <div>
              <ButtonLink href="/settings/export" variant="secondary">
                {t("shred.request.exportLink")}
              </ButtonLink>
            </div>
          </div>
        ) : (
          <RequestShredForm exports={usable} />
        )}
      </Card>
      <Card as="section" title={t("shred.list.title")} headingLevel={2}>
        {requests.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("shred.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {requests.data.items.map((item) => {
              const chip = shredChip(shredState(item), t);
              return (
                <li key={item.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <h3 className="m-0 text-body font-semibold">
                    <Link href={shredHref(item.id)} className="underline">
                      {t("shred.list.heading", { when: when(item.requestedAt) })}
                    </Link>
                  </h3>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    <span className="text-body-dense">
                      {t("shred.list.requested", {
                        name: memberName(item.requestedByName, t),
                        when: when(item.requestedAt),
                      })}
                    </span>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

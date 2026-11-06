import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { FileCheck2, Lock, LockOpen, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DestroyForm, PlaceHoldForm, ReleaseHoldForm } from "@/components/retention/RetentionForms";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";
import { methodWords, RETENTION_PAGE, retentionShown, splitHolds } from "@/lib/retention";
import { certificateHref, SHRED_PAGE } from "@/lib/shred";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("retention.title") };

const count = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/**
 * Records retention (PLAT-012; platform.md, retention and legal hold; retention.md), for holders of
 * `platform.retention.manage` (the data protection lead's tenant-wide roles). Legal holds in force
 * and released, placing and releasing one; the documents past their retention period with no hold
 * (only what the API offers, which never includes held records or people still receiving care),
 * destroyed only after a reason, an acknowledgement and a confirmation that say it cannot be
 * undone; and the destruction certificates. Every route needs a fresh step-up, so the page sends
 * the person to confirm it is them first and back here.
 */
export default async function RetentionPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("retention.title");
  if (!retentionShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const [holds, candidates, certificates, people] = await Promise.all([
    api.GET("/v1/legal-holds"),
    api.GET("/v1/retention/candidates"),
    api.GET("/v1/destruction-certificates"),
    api.GET("/v1/people", {}).catch(() => null),
  ]);
  if (!holds.data) failWith(holds.error, holds.response, RETENTION_PAGE);
  if (!candidates.data) failWith(candidates.error, candidates.response, RETENTION_PAGE);
  if (!certificates.data) failWith(certificates.error, certificates.response, RETENTION_PAGE);
  const { inForce, released } = splitHolds(holds.data.items);
  const peopleList = people?.data?.items ?? [];
  const names = new Map(peopleList.map((p) => [p.id, personNames(p).full]));
  const byId = new Map(peopleList.map((p) => [p.id, p]));
  const personOptions = peopleList.map((p) => ({
    id: p.id,
    label: t("retention.hold.personOption", {
      name: personNames(p).full,
      status: p.status,
    }),
  }));
  const query = await searchParams;
  const done = firstParam(query.done);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";
  const about = (hold: (typeof inForce)[number]) =>
    hold.personId
      ? t("retention.hold.aboutPerson", {
          name: names.get(hold.personId) ?? t("retention.hold.aPerson"),
        })
      : t("retention.hold.aboutRecord", {
          type: hold.subjectType ?? "",
          id: hold.subjectId ?? "",
        });
  const needs = (hold: (typeof inForce)[number]) => {
    const person = hold.personId ? byId.get(hold.personId) : undefined;
    return person ? <PersonNeeds person={person} /> : null;
  };

  const arrival =
    done === "destroyed"
      ? t("retention.done.destroyed", {
          destroyed: count(firstParam(query.destroyed)),
          skipped: count(firstParam(query.skipped)),
          certificates: count(firstParam(query.certificates)),
        })
      : done === "placed" || done === "released"
        ? t("retention.done.hold", { done })
        : null;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("retention.description")} />
      {arrival ? <RecordedArrival message={arrival} param="done" /> : null}
      <Card as="section" title={t("retention.holds.title")} headingLevel={2}>
        {inForce.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<ShieldCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("retention.holds.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {inForce.map((hold) => (
              <li key={hold.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">{about(hold)}</h3>
                {needs(hold)}
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <StatusChip status="info" label={t("retention.holds.inForce")} icon={Lock} />
                  <span className="text-body-dense">
                    {t("retention.holds.placed", { dateTime: when(hold.placedAt) })}
                  </span>
                </p>
                <p className="m-0">{t("retention.holds.reason", { reason: hold.reason })}</p>
                <div>
                  <ReleaseHoldForm hold={hold} about={about(hold)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("retention.hold.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose">{t("retention.hold.about")}</p>
          <PlaceHoldForm people={personOptions} />
        </div>
      </Card>
      <Card as="section" title={t("retention.destroy.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose">{t("retention.destroy.about")}</p>
          {candidates.data.items.length === 0 ? (
            <EmptyState
              headingLevel={3}
              icon={<FileCheck2 size={32} strokeWidth={1.5} aria-hidden="true" />}
              title={t("retention.destroy.empty")}
            />
          ) : (
            <DestroyForm candidates={candidates.data.items} />
          )}
        </div>
      </Card>
      <Card as="section" title={t("shred.entry.title")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 max-w-prose">{t("shred.entry.about")}</p>
          <p className="m-0">
            <Link href={SHRED_PAGE} className="inline-flex min-h-target items-center underline">
              {t("shred.entry.link")}
            </Link>
          </p>
        </div>
      </Card>
      <Card as="section" title={t("retention.certificates.title")} headingLevel={2}>
        {certificates.data.items.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<FileCheck2 size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("retention.certificates.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {certificates.data.items.map((cert) => (
              <li key={cert.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  <Link
                    href={certificateHref(cert.id)}
                    className="inline-flex min-h-target items-center underline"
                  >
                    {cert.subjectType === "tenant"
                      ? t("shred.certificate.listHeading", { dateTime: when(cert.executedAt) })
                      : t("retention.certificate.heading", {
                          count: cert.recordCount,
                          recordClass: cert.recordClass,
                          dateTime: when(cert.executedAt),
                        })}
                  </Link>
                </h3>
                <p className="m-0">{t("retention.holds.reason", { reason: cert.reason })}</p>
                <p className="m-0 text-body-dense">{methodWords(cert.method, t)}</p>
                <p className="m-0 text-body-dense break-all">
                  {t("retention.certificate.reference", { id: cert.id })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {released.length > 0 ? (
        <Card as="section" title={t("retention.released.title")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {released.map((hold) => (
              <li key={hold.id} className="flex flex-col gap-1 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">{about(hold)}</h3>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <StatusChip
                    status="notApplicable"
                    label={t("retention.released.state")}
                    icon={LockOpen}
                  />
                  <span className="text-body-dense">
                    {t("retention.released.when", {
                      placed: when(hold.placedAt),
                      released: when(hold.releasedAt),
                    })}
                  </span>
                </p>
                <p className="m-0">{t("retention.holds.reason", { reason: hold.reason })}</p>
                {hold.releaseReason ? (
                  <p className="m-0">
                    {t("retention.released.reason", { reason: hold.releaseReason })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

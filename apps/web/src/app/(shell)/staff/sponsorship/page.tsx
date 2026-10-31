import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Stamp } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { SponsoredWorkerForm } from "@/components/staff/SponsorForms";
import { StaffChip } from "@/components/staff/StaffChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  choosableMembers,
  othersOnly,
  reportChip,
  SPONSOR_PAGE,
  STAFF_PAGE,
  salaryChip,
  sponsorManaged,
  sponsorShown,
  visaChip,
} from "@/lib/staff";

export const metadata: Metadata = { title: t("sponsor.title") };

/**
 * Sponsored workers (WORK-003; workforce.md section 12): HR only (workforce.immigration.read),
 * never one's own record. Each worker's visa, salary check, Appendix D gaps and open reports, each
 * as an icon and a word; a new record for holders of workforce.sponsor.manage. Harbour keeps the
 * records and clocks; it never decides anyone's immigration status.
 */
export default async function SponsorshipPage() {
  const { me } = await getShellContext();
  const title = t("sponsor.title");
  if (!sponsorShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/sponsored-workers");
  if (!listed.data) failWith(listed.error, listed.response, SPONSOR_PAGE);
  const workers = othersOnly(listed.data.items, me.tenantUserId);
  const manage = sponsorManaged(me.permissions);
  const members = manage ? await api.GET("/v1/workforce/staff-members") : null;
  const active = workers.filter((w) => w.status === "active").map((w) => w.tenantUserId);
  const choosable = choosableMembers(members?.data?.items ?? [], me.tenantUserId, active);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("sponsor.description")} />
      <p className="m-0">
        <Link href={STAFF_PAGE} className="inline-flex min-h-target items-center underline">
          {t("sponsor.backToStaff")}
        </Link>
      </p>
      <Card as="section" title={t("sponsor.list.title")} headingLevel={2}>
        {workers.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<Stamp size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("sponsor.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {workers.map((w) => {
              const open = w.reports.filter((r) => r.state === "open" || r.state === "overdue");
              return (
                <li key={w.id} className="flex flex-col gap-1 border-b border-border pb-3">
                  <h3 className="m-0 text-body font-semibold">
                    <Link
                      href={`${SPONSOR_PAGE}/${w.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {w.member?.displayName ?? t("staff.unknownMember")}
                    </Link>
                  </h3>
                  <p className="m-0 text-body-dense">
                    {t("sponsor.list.line", {
                      route: w.route,
                      date: formatDate(w.visaExpiresOn) ?? "",
                      status: w.status,
                    })}
                  </p>
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StaffChip chip={visaChip(w.visa, t)} />
                    <StaffChip chip={salaryChip(w.salary.passes, t)} />
                    {open.map((r) => (
                      <StaffChip key={r.id} chip={reportChip(r.state, t)} />
                    ))}
                    {w.appendixDGaps.length > 0 ? (
                      <span className="text-body-dense">
                        {t("sponsor.list.gaps", { count: w.appendixDGaps.length })}
                      </span>
                    ) : null}
                    {w.absenceToReport ? (
                      <span className="text-body-dense">{t("sponsor.list.absenceToReport")}</span>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {manage ? (
        <Card as="section" title={t("sponsor.create.title")} headingLevel={2}>
          {choosable.length === 0 ? (
            <p className="m-0">{t("staff.create.noneToChoose")}</p>
          ) : (
            <SponsoredWorkerForm members={choosable} />
          )}
        </Card>
      ) : null}
    </div>
  );
}

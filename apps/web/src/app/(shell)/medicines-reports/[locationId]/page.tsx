import { Card } from "@harbour/ui";
import { CalendarClock, ChartColumn, ClipboardList, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ReportFrame } from "@/components/medicines/errors/ReportFrame";
import { reportLocation } from "@/components/medicines/errors/report-location";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { t } from "@/lib/i18n";
import { REPORT_NAMES, type ReportName, reportHref } from "@/lib/medication-errors";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.errors.reports.title") };

const ICONS: Readonly<Record<ReportName, typeof ChartColumn>> = {
  reviews: CalendarClock,
  overrides: ShieldAlert,
  prn: ClipboardList,
  trend: ChartColumn,
};

/**
 * The medicines reports for one location (slice 55; medicines.md sections 14.2 and 14.3): the
 * medication review tracker, competence overrides and doses recorded after they were given, PRN and
 * psychotropic use, and the medication error trend. Each is information for a person to read.
 */
export default async function LocationReportsPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  const title = t("medicines.errors.reports.title");
  const location = await reportLocation(locationId);
  if (!location) return <SafetyForbidden title={title} />;
  return (
    <ReportFrame
      locationId={location.id}
      locationName={location.name}
      title={title}
      description={t("medicines.errors.reports.description")}
    >
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
        {REPORT_NAMES.map((report) => {
          const Icon = ICONS[report];
          return (
            <li key={report}>
              <Card as="article">
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 flex items-center gap-2 text-body font-semibold">
                    <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
                    <Link
                      href={reportHref(location.id, report)}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("medicines.errors.reports.name", { report })}
                    </Link>
                  </h2>
                  <p className="m-0">{t("medicines.errors.reports.about", { report })}</p>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </ReportFrame>
  );
}

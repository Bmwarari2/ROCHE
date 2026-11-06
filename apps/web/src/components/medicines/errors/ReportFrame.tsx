import { PageHeader } from "@harbour/ui";
import { Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/care/Notice";
import { t } from "@/lib/i18n";
import { REPORTS_HREF, reportsHref } from "@/lib/medication-errors";

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * The frame of a medicines report for one location (slice 55; medicines.md section 14.3): the
 * breadcrumb back to the reports, the heading with the location's name, and the reminder that the
 * report counts records for a person to read, never a judgement (medical-device boundary).
 */
export function ReportFrame({
  locationId,
  locationName,
  title,
  description,
  informationOnly = true,
  children,
}: {
  readonly locationId: string;
  readonly locationName: string;
  readonly title: string;
  readonly description: string;
  readonly informationOnly?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href={REPORTS_HREF} className="underline">
          {t("medicines.errors.reports.title")}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <Link href={reportsHref(locationId)} className="underline">
          {locationName}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader eyebrow={locationName} title={title} description={description} />
      {informationOnly ? (
        <Notice icon={<Info {...iconProps} />} title={t("medicines.errors.reports.countsOnly")}>
          {t("medicines.errors.reports.countsOnlyHint")}
        </Notice>
      ) : null}
      {children}
    </div>
  );
}

/** A report the API would not give, in its own words (a period too long, for example). */
export function ReportRefused({ message }: { readonly message: string }) {
  return (
    <Notice
      tone="warning"
      icon={<TriangleAlert {...iconProps} />}
      title={t("medicines.errors.reports.refused")}
    >
      {message}
    </Notice>
  );
}

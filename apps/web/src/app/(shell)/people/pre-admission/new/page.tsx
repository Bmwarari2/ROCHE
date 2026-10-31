import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EnquiryForm } from "@/components/people/admission/EnquiryForm";
import { ENQUIRY_MANAGE } from "@/lib/admission";
import { getShellContext } from "@/lib/api";
import { can } from "@/lib/care-record";
import { peopleLabel, t } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  const { me } = await getShellContext();
  return {
    title: t("care.title.tab", {
      tab: t("people.enquiry.new.title"),
      people: peopleLabel(me.tenant.terminology),
    }),
  };
}

/**
 * Record an enquiry (people.md rule 1; people.enquiry.manage). Before a new record is made, the
 * page asks the person to search first: someone who lived here before keeps their record and is
 * re-referred on it (one person, one record; HZ-001).
 */
export default async function NewEnquiryPage() {
  const { me, locationId } = await getShellContext();
  const title = t("people.enquiry.new.title");
  const breadcrumb = (
    <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
      <Link href="/people" className="underline">
        {peopleLabel(me.tenant.terminology)}
      </Link>
      <span aria-hidden="true" className="px-2 text-text-secondary">
        ›
      </span>
      <Link href="/people/pre-admission" className="underline">
        {t("people.preAdmission.list.title")}
      </Link>
      <span aria-hidden="true" className="px-2 text-text-secondary">
        ›
      </span>
      <span>{title}</span>
    </nav>
  );
  if (!can(me.permissions, ENQUIRY_MANAGE) || me.locations.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-8">
        {breadcrumb}
        <PageHeader title={title} />
        <EmptyState
          icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("errors.forbidden")}
        />
      </div>
    );
  }
  return (
    <div className="flex w-full flex-col gap-6">
      {breadcrumb}
      <PageHeader title={title} description={t("people.enquiry.new.description")} />
      <p className="m-0 max-w-prose">
        {t("people.enquiry.new.searchFirst")}{" "}
        <Link href="/search" className="inline-flex min-h-target items-center underline">
          {t("people.enquiry.new.searchLink")}
        </Link>
      </p>
      <Card as="section" title={t("people.enquiry.new.formTitle")} headingLevel={2}>
        <EnquiryForm
          locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
          defaultLocationId={locationId}
        />
      </Card>
    </div>
  );
}

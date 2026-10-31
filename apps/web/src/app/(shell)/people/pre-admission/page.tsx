import type { PersonSummary } from "@harbour/contracts";
import { ButtonLink, Card, EmptyState, PageHeader } from "@harbour/ui";
import { ClipboardList, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { PersonStatusChip } from "@/components/people/admission/StatusChips";
import { CommunicationStatus } from "@/components/people/CommunicationStatus";
import { SampleBadge } from "@/components/people/SampleBadge";
import {
  ENQUIRY_MANAGE,
  isPreAdmissionStage,
  preAdmissionShown,
  splitPreAdmission,
} from "@/lib/admission";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { peopleLabel, t } from "@/lib/i18n";
import { communicationSummary, personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  const { me } = await getShellContext();
  return {
    title: t("care.title.tab", {
      tab: t("people.preAdmission.list.title"),
      people: peopleLabel(me.tenant.terminology),
    }),
  };
}

/** One person on the list: never the medical details, which stay on the record. */
function PersonRow({
  person,
  locationName,
}: {
  readonly person: PersonSummary;
  readonly locationName: string | null;
}) {
  const names = personNames(person);
  return (
    <li className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <span className="flex flex-wrap items-center gap-2">
        <Link
          href={`/people/${person.id}/pre-admission`}
          className="inline-flex min-h-target items-center font-semibold text-link underline"
        >
          {names.hasPreferred
            ? t("people.preAdmission.list.nameWithPreferred", {
                preferred: names.preferred,
                full: names.full,
              })
            : names.full}
        </Link>
        <PersonStatusChip status={person.status} />
        <SampleBadge sample={person.sample} />
      </span>
      <span className="text-body-dense text-text-secondary">
        {t("people.preAdmission.list.details", {
          dob: formatDate(person.dateOfBirth) ?? t("common.notRecorded"),
          since: formatDateTime(person.statusChangedAt) ?? "",
        })}
        {locationName ? ` ${locationName}` : null}
      </span>
      {/* Communication needs wherever a person is shown (Accessible Information Standard). */}
      <span className="flex flex-wrap items-center gap-2 text-body-dense">
        <span>{t("people.header.communicationNeeds")}</span>
        <CommunicationStatus
          summary={communicationSummary(person, t)}
          flagLabel={t("people.header.communicationNeeds")}
          compact
        />
      </span>
    </li>
  );
}

/**
 * Enquiries and pre-admission assessments (people.md rules 1 and 4; PEOP-005): the people not yet
 * admitted at the chosen location, each opening on their pre-admission tab. They are kept off the
 * list of residents, which is for people receiving care.
 */
export default async function PreAdmissionListPage(props: { readonly searchParams: SearchParams }) {
  const { me, locationId } = await getShellContext();
  const title = t("people.preAdmission.list.title");
  if (!preAdmissionShown(me.permissions)) {
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-8">
        <PageHeader title={title} />
        <EmptyState
          icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("errors.forbidden")}
        />
      </div>
    );
  }
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/people", {
    params: { query: locationId ? { locationId } : {} },
  });
  if (!data) {
    if (problemCode(error) === "missing_permission") {
      return (
        <div className="mx-auto flex w-full max-w-content flex-col gap-8">
          <PageHeader title={title} />
          <EmptyState
            icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("errors.forbidden")}
          />
        </div>
      );
    }
    failWith(error, response, "/people/pre-admission");
  }
  const query = await props.searchParams;
  const done = firstParam(query.done);
  const locationNames = new Map(me.locations.map((l) => [l.id, l.name]));
  const showLocation = me.locations.length > 1 && !locationId;
  const { open, closed } = splitPreAdmission(
    data.items.filter((p) => isPreAdmissionStage(p.status)),
  );
  const location = me.locations.find((l) => l.id === locationId);
  const row = (person: PersonSummary) => (
    <PersonRow
      key={person.id}
      person={person}
      locationName={showLocation ? (locationNames.get(person.locationId) ?? null) : null}
    />
  );

  return (
    <div className="flex w-full flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/people" className="underline">
          {peopleLabel(me.tenant.terminology)}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span>{title}</span>
      </nav>
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("people.preAdmission.list.description")}
        primaryAction={
          can(me.permissions, ENQUIRY_MANAGE) ? (
            <ButtonLink href="/people/pre-admission/new">
              {t("people.enquiry.new.title")}
            </ButtonLink>
          ) : undefined
        }
      />
      {done === "closed" ? (
        <TemplateArrival message={t("people.preAdmission.list.closed")} />
      ) : null}
      <Card
        as="section"
        title={t("people.preAdmission.list.openTitle")}
        description={t("people.preAdmission.list.openCount", { count: open.length })}
        headingLevel={2}
      >
        {open.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<ClipboardList size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("people.preAdmission.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">{open.map(row)}</ul>
        )}
      </Card>
      {closed.length > 0 ? (
        <Card
          as="section"
          title={t("people.preAdmission.list.closedTitle")}
          description={t("people.preAdmission.list.closedHint")}
          headingLevel={2}
        >
          <ul className="m-0 flex list-none flex-col p-0">{closed.map(row)}</ul>
        </Card>
      ) : null}
    </div>
  );
}

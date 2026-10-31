import type { ContactOut, PersonDetails } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import {
  Calendar,
  CalendarCheck,
  CircleX,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { ContactForm, DetailsForm, OptOutForm } from "@/components/people/DetailsForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  addressLine,
  codeLabel,
  contactGroups,
  contactName,
  contactStatuses,
} from "@/lib/person-details";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("details");
}

const STATUS_ICONS = {
  "circle-x": CircleX,
  "triangle-alert": TriangleAlert,
  "calendar-check": CalendarCheck,
  calendar: Calendar,
};

/** What each form's `done` says when the page opens again. */
const DONE: Record<string, () => string> = {
  details: () => t("people.details.saved"),
  optOutRecorded: () => t("people.optOut.saved", { optedOut: "yes" }),
  optInRecorded: () => t("people.optOut.saved", { optedOut: "no" }),
  contactAdded: () => t("people.contacts.added"),
  contactSaved: () => t("people.contacts.saved"),
};

/** Labelled values; a value not recorded says so, never left blank. */
function Fields({ rows }: { readonly rows: readonly (readonly [string, string | null])[] }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {rows.map(([field, value]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">{t("people.details.field", { field })}</dt>
          <dd className={`m-0 break-words ${value ? "" : "text-text-secondary"}`}>
            {value ?? t("common.notRecorded")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function detailRows(details: PersonDetails): (readonly [string, string | null])[] {
  return [
    ["title", details.title],
    ["givenName", details.givenName],
    ["familyName", details.familyName],
    ["preferredName", details.preferredName],
    ["dateOfBirth", formatDate(details.dateOfBirth)],
    ["nhsNumber", formatNhsNumber(details.nhsNumber)],
    ["localIdentifier", details.localIdentifier],
    ["sexCode", codeLabel("people.details.sex", details.sexCode, t)],
    ["genderIdentity", codeLabel("people.details.sex", details.genderIdentity, t)],
    [
      "ethnicCategoryCode",
      codeLabel("people.details.ethnicCategory", details.ethnicCategoryCode, t),
    ],
    ["religion", details.religion],
    ["firstLanguage", codeLabel("people.details.language", details.firstLanguage, t)],
    [
      "interpreterRequired",
      t("people.details.interpreter", { required: details.interpreterRequired ? "yes" : "no" }),
    ],
    [
      "address",
      addressLine([details.addressLine1, details.addressLine2, details.town, details.postcode]),
    ],
    ["gpPracticeOdsCode", details.gpPracticeOdsCode],
    ...(details.legalStatus ? [["legalStatus", details.legalStatus] as const] : []),
  ];
}

/** One contact or representative, with what their authority covers and until when. */
function ContactCard({
  contact,
  documents,
  canWrite,
  personId,
  path,
}: {
  readonly contact: ContactOut;
  readonly documents: ReadonlyMap<string, string>;
  readonly canWrite: boolean;
  readonly personId: string;
  readonly path: string;
}) {
  const statuses = contactStatuses(contact, t);
  const evidence = contact.authorityDocumentId
    ? (documents.get(contact.authorityDocumentId) ?? null)
    : null;
  const rows: (readonly [string, string | null])[] = [
    ["relationship", contact.relationship],
    ["phone", contact.phone],
    ["email", contact.email],
    ["address", addressLine([contact.addressLine1, contact.town, contact.postcode])],
    ["reference", contact.authorityReference],
    [
      "scope",
      contact.authorityScope ? t("people.contacts.scope", { scope: contact.authorityScope }) : null,
    ],
    ["notes", contact.notes],
  ];
  const shown = rows.filter(([, value]) => Boolean(value));
  return (
    <li className="flex flex-col gap-3 border-b border-border pb-4" data-contact={contact.id}>
      <div className="flex flex-col gap-1">
        <h5 className="m-0 inline-flex items-center gap-2 text-body font-semibold">
          <UserRound size={18} strokeWidth={1.5} aria-hidden="true" />
          {contactName(contact)}
        </h5>
        <p className="m-0 text-body-dense text-text-secondary">
          {t("people.contacts.role", { role: contact.role })}
        </p>
      </div>
      {statuses.length > 0 || contact.isNextOfKin ? (
        <p className="m-0 flex flex-wrap items-center gap-2">
          {contact.isNextOfKin ? (
            <StatusChip status="info" label={t("people.contacts.nextOfKin")} />
          ) : null}
          {statuses.map((status) => (
            <StatusChip
              key={status.kind}
              {...(status.tone === "neutral"
                ? { status: "neutral" as const }
                : { status: status.tone })}
              label={status.label}
              icon={STATUS_ICONS[status.icon]}
            />
          ))}
        </p>
      ) : null}
      {contact.evidenceMissing ? (
        <p className="m-0 max-w-prose">{t("people.contacts.evidenceMissingDetail")}</p>
      ) : null}
      {shown.length > 0 ? (
        <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {shown.map(([field, value]) => (
            <div key={field} className="min-w-0">
              <dt className="text-body-dense font-semibold">
                {t("people.contacts.field", { field })}
              </dt>
              <dd className="m-0 whitespace-pre-line break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {contact.authorityDocumentId ? (
        <p className="m-0">
          <Link
            href={`/documents/${contact.authorityDocumentId}`}
            className="inline-flex min-h-target items-center underline"
          >
            {t("people.contacts.evidenceDocument", {
              title: evidence ?? t("people.contacts.field", { field: "evidence" }),
            })}
          </Link>
        </p>
      ) : null}
      {canWrite ? (
        <ContactForm
          personId={personId}
          path={path}
          contact={contact}
          documents={[...documents].map(([id, title]) => ({ id, title }))}
        />
      ) : null}
    </li>
  );
}

/**
 * The personal details tab (PEOP-001; people.md rule 15; data-standards.md `person` and
 * `contact`): the MODS-aligned demographics, the national data opt-out in words and an icon, and
 * the key contacts and legal representatives with their authority, evidence and end date. Anyone
 * who reads the record sees it; `people.person.update` where it reaches the person changes it.
 */
async function DetailsTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "people.person.read")) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const path = tabHref(id, "details");
  const { canWrite, readOnlyNotice } = writeAccess(person, me.permissions, "people.person.update");
  const api = await tenantApi();
  const [details, contacts, documents] = await Promise.all([
    api
      .GET("/v1/people/{id}/details", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/contacts", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    // The person's own documents, to name and choose the evidence of an authority.
    api.GET("/v1/documents", {
      params: { query: { personId: id, category: "person_document" } },
    }),
  ]);
  if (!details || !contacts) return <NoAccess />;
  const documentTitles = new Map(
    (documents.data?.items ?? [])
      .filter((d) => d.status === "available")
      .map((d) => [d.id, d.title] as const),
  );
  const groups = contactGroups(contacts.items);
  const optedOut = details.nationalDataOptOut;
  const OptOutIcon = optedOut ? ShieldOff : ShieldCheck;
  const doneMessage = done ? DONE[done]?.() : undefined;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.details.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.details.intro")}</p>
      </div>
      {doneMessage ? <TemplateArrival key={at} message={doneMessage} /> : null}
      {readOnlyNotice ? <ReadOnlyNotice text={t(readOnlyNotice)} /> : null}
      <Card as="section" title={t("people.optOut.title")} headingLevel={3}>
        <div
          className="flex flex-col gap-3"
          data-opt-out={optedOut ? "opted_out" : "not_opted_out"}
        >
          <p className="m-0 inline-flex items-center gap-2 font-semibold">
            <OptOutIcon size={20} strokeWidth={1.5} aria-hidden="true" />
            {t("people.optOut.status", { optedOut: optedOut ? "yes" : "no" })}
          </p>
          <p className="m-0 max-w-prose">
            {t("people.optOut.detail", { optedOut: optedOut ? "yes" : "no" })}
          </p>
          <p className="m-0 max-w-prose text-body-dense text-text-secondary">
            {t("people.optOut.source")}
          </p>
          {canWrite ? (
            <OptOutForm
              key={at}
              personId={id}
              path={path}
              optedOut={optedOut}
              version={details.version}
            />
          ) : null}
        </div>
      </Card>
      <Card as="section" title={t("people.details.whoTheyAre")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          <Fields rows={detailRows(details)} />
          <p className="m-0">
            <Link
              href={tabHref(id, "about-me")}
              className="inline-flex min-h-target items-center underline"
            >
              {t("people.details.aboutMeLink")}
            </Link>
          </p>
          {canWrite ? <DetailsForm key={at} personId={id} path={path} details={details} /> : null}
        </div>
      </Card>
      <Card as="section" title={t("people.contacts.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose text-text-secondary">{t("people.contacts.intro")}</p>
          {(
            [
              ["representatives", groups.representatives, "people.contacts.noneRepresentatives"],
              ["others", groups.others, "people.contacts.noneOthers"],
            ] as const
          ).map(([group, items, empty]) => (
            <section
              key={group}
              aria-labelledby={`contacts-${group}`}
              className="flex flex-col gap-3"
            >
              <h4 id={`contacts-${group}`} className="m-0 text-eyebrow">
                {t(`people.contacts.${group}`)}
              </h4>
              {items.length === 0 ? (
                <p className="m-0 text-text-secondary">{t(empty)}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0">
                  {items.map((contact) => (
                    <ContactCard
                      key={`${contact.id}:${at}`}
                      contact={contact}
                      documents={documentTitles}
                      canWrite={canWrite}
                      personId={id}
                      path={path}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
          {canWrite ? (
            <ContactForm
              key={at}
              personId={id}
              path={path}
              documents={[...documentTitles].map(([docId, title]) => ({ id: docId, title }))}
            />
          ) : null}
        </div>
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function PersonDetailsPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="details">
      <DetailsTab {...props} />
    </RecordFrame>
  );
}

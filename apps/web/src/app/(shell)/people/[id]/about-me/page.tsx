import type { AboutMeShareLinkOut } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { Ban, CircleCheck, CircleX, Clock, Images } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { AboutMeForm, RevokeLink, ShareLinkForm } from "@/components/people/AboutMeForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import {
  ABOUT_ME_KEYS,
  aboutMeMediaCount,
  aboutMeText,
  decisionLastDay,
  type LinkStatus,
  linkDecisions,
  linkStatus,
} from "@/lib/sharing";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("about-me");
}

const DONE: Record<string, () => string> = {
  aboutMe: () => t("people.aboutMe.saved"),
  linkRevoked: () => t("people.links.revoked"),
};

const LINK_CHIPS: Record<
  LinkStatus,
  { readonly status: "done" | "overdue" | "neutral"; readonly icon: typeof CircleCheck }
> = {
  active: { status: "done", icon: CircleCheck },
  revoked: { status: "neutral", icon: CircleX },
  expired: { status: "neutral", icon: Clock },
  closed: { status: "overdue", icon: Ban },
};

/** About me can be written by staff with the person, under any one of these (people.md 3). */
const ABOUT_ME_WRITERS = ["people.person.update", "care.plan.write"] as const;

function LinkItem({
  link,
  now,
  personId,
  path,
}: {
  readonly link: AboutMeShareLinkOut;
  readonly now: Date;
  readonly personId: string;
  readonly path: string;
}) {
  const status = linkStatus(link, now);
  const chip = LINK_CHIPS[status];
  const made = formatDateTime(link.createdAt) ?? "";
  return (
    <li className="flex flex-col gap-2 border-b border-border pb-4" data-link={link.id}>
      <p className="m-0 flex flex-wrap items-center gap-2">
        {chip.status === "neutral" ? (
          <StatusChip
            status="neutral"
            label={t("people.links.status", { status })}
            icon={chip.icon}
          />
        ) : (
          <StatusChip
            status={chip.status}
            label={t("people.links.status", { status })}
            icon={chip.icon}
          />
        )}
      </p>
      <p className="m-0 flex flex-wrap gap-x-4 text-body-dense text-text-secondary">
        <span>{t("people.links.made", { dateTime: made })}</span>
        <span>
          {t("people.links.expires", {
            status: status === "expired" ? "expired" : "other",
            dateTime: formatDateTime(link.expiresAt) ?? "",
          })}
        </span>
        <span>
          {link.lastOpenedAt
            ? t("people.links.lastOpened", { dateTime: formatDateTime(link.lastOpenedAt) ?? "" })
            : t("people.links.neverOpened")}
        </span>
      </p>
      {link.revokedAt ? (
        <p className="m-0">
          {t("people.links.revokedLine", {
            dateTime: formatDateTime(link.revokedAt) ?? "",
            reason: link.revokedReason ?? "",
          })}
        </p>
      ) : status !== "expired" ? (
        <RevokeLink
          personId={personId}
          path={path}
          linkId={link.id}
          version={link.version}
          made={made}
        />
      ) : null}
    </li>
  );
}

/**
 * The About me tab (PEOP-003; PRSB About Me v2.01; people.md rule 9): the seven parts in the
 * person's words, who wrote it and when, and the share links made under a sharing decision
 * (rule 13; HZ-022) for those who manage sharing. Anyone who reads the record reads About me;
 * staff writing it with the person need `people.person.update` or `care.plan.write`.
 */
async function AboutMeTab({
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
  const path = tabHref(id, "about-me");
  const writers = ABOUT_ME_WRITERS.map((p) => writeAccess(person, me.permissions, p));
  const canWrite = writers.some((w) => w.canWrite);
  const readOnlyNotice = canWrite
    ? null
    : (writers.find((w) => w.readOnlyNotice)?.readOnlyNotice ?? null);
  const manageSharing = writeAccess(person, me.permissions, "people.sharing.manage").canWrite;
  const api = await tenantApi();
  const [about, links, decisions] = await Promise.all([
    api
      .GET("/v1/people/{id}/about-me", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    manageSharing ? api.GET("/v1/people/{id}/about-me/links", { params: { path: { id } } }) : null,
    manageSharing
      ? api.GET("/v1/people/{id}/sharing-decisions", { params: { path: { id } } })
      : null,
  ]);
  if (!about) return <NoAccess />;
  const name = personNames(person).preferred;
  const now = new Date();
  const doneMessage = done ? DONE[done]?.() : undefined;
  const filled = ABOUT_ME_KEYS.filter((key) => aboutMeText(about, key) !== null).length;
  const supporter = about.sections.supported_to_write_this_by;
  const options = linkDecisions(decisions?.data?.items ?? []).map((d) => ({
    id: d.id,
    validTo: d.validTo,
    lastDay: formatDate(decisionLastDay(d.validTo)) ?? "",
    label: t("people.links.form.decisionOption", {
      from: formatDateTime(d.validFrom) ?? "",
      to: formatDateTime(d.validTo) ?? "",
    }),
  }));

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.aboutMe.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.aboutMe.intro", { name })}</p>
      </div>
      {doneMessage ? <TemplateArrival key={at} message={doneMessage} /> : null}
      {readOnlyNotice ? <ReadOnlyNotice text={t(readOnlyNotice)} /> : null}
      <Card as="section" title={t("people.aboutMe.title")} headingLevel={3}>
        <div className="flex flex-col gap-4" data-about-me="">
          {about.summary.hasContent ? (
            <p className="m-0 flex flex-col gap-1">
              <span className="font-semibold">{t("people.aboutMe.filled", { count: filled })}</span>
              <span>
                {about.authoredByPerson
                  ? t("people.aboutMe.byPerson", { name })
                  : supporter
                    ? t("people.aboutMe.supported", { supporter })
                    : null}
              </span>
              {about.summary.dateLastUpdated ? (
                <span className="text-body-dense text-text-secondary">
                  {t("people.aboutMe.updated", {
                    dateTime: formatDateTime(about.summary.dateLastUpdated) ?? "",
                  })}
                </span>
              ) : null}
            </p>
          ) : (
            <p className="m-0">{t("people.aboutMe.none")}</p>
          )}
          {about.summary.hasContent
            ? ABOUT_ME_KEYS.map((key) => {
                const words = aboutMeText(about, key);
                const media = aboutMeMediaCount(about, key);
                return (
                  <section
                    key={key}
                    aria-labelledby={`about-me-${key}`}
                    className="flex flex-col gap-1"
                  >
                    <h4 id={`about-me-${key}`} className="m-0 text-body font-semibold">
                      {t("people.aboutMe.section", { section: key })}
                    </h4>
                    <p
                      className={`m-0 max-w-prose whitespace-pre-wrap break-words ${words ? "" : "text-text-secondary"}`}
                    >
                      {words ?? t("people.aboutMe.emptyPart")}
                    </p>
                    {media > 0 ? (
                      <p className="m-0 inline-flex items-center gap-2 text-body-dense">
                        <Images size={16} strokeWidth={1.5} aria-hidden="true" />
                        {t("people.aboutMe.media", { count: media })}
                      </p>
                    ) : null}
                  </section>
                );
              })
            : null}
          {canWrite ? (
            <AboutMeForm key={at} personId={id} path={path} about={about} name={name} />
          ) : null}
        </div>
      </Card>
      {manageSharing ? (
        <Card as="section" title={t("people.links.title")} headingLevel={3}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose text-text-secondary">{t("people.links.intro")}</p>
            {links?.data ? (
              links.data.items.length === 0 ? (
                <p className="m-0">{t("people.links.none")}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0">
                  {links.data.items.map((link) => (
                    <LinkItem
                      key={`${link.id}:${at}`}
                      link={link}
                      now={now}
                      personId={id}
                      path={path}
                    />
                  ))}
                </ul>
              )
            ) : (
              <p className="m-0">{t("errors.mfaVerifyRequired")}</p>
            )}
            <h4 className="m-0 text-body font-semibold">{t("people.links.make")}</h4>
            {options.length > 0 ? (
              <ShareLinkForm personId={id} path={path} decisions={options} />
            ) : (
              <p className="m-0 flex flex-col gap-1">
                <span>{t("people.links.form.noDecision")}</span>
                <Link
                  href={tabHref(id, "sharing")}
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("people.links.form.sharingTab")}
                </Link>
              </p>
            )}
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function AboutMePage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="about-me">
      <AboutMeTab {...props} />
    </RecordFrame>
  );
}

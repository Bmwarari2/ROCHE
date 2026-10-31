import type { LetterItem } from "@harbour/contracts";
import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { LetterComposer } from "@/components/comms/LetterComposer";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  emailTemplatesLeftOut,
  LETTER_MANAGE,
  mergeFieldNames,
  templateName,
  templatesForLetters,
  typedFieldsOf,
} from "@/lib/letters";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("letters");
}

/**
 * The letters tab (comms.md rules 24 and 25; COMMS-007; HZ-051): make a posted letter from an
 * approved template, checked in a preview that shows who it is about, and the letters already sent.
 * `comms.letter.manage` with MFA; an incident follow-up also needs `safety.incident.manage`.
 */
async function LettersTab({
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
  const path = tabHref(id, "letters");
  if (!can(me.permissions, LETTER_MANAGE)) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const incidentsAllowed = can(me.permissions, "safety.incident.manage");
  const api = await tenantApi();
  const [templates, letters, incidents] = await Promise.all([
    api.GET("/v1/letter-templates").then((r) => readOrFail(r, path)),
    api.GET("/v1/people/{id}/letters", { params: { path: { id } } }),
    incidentsAllowed
      ? api
          .GET("/v1/incidents", { params: { query: { personId: id } } })
          .then((r) => r.data ?? null)
      : null,
  ]);
  // Letters hold the person's details: the API asks for MFA first, as the frame's notices say.
  const sent: LetterItem[] = letters.data?.items ?? [];
  const lettersRefused = letters.data ? null : problemCode(letters.error);
  const usable = templatesForLetters(templates?.items ?? [], incidents !== null);

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("comms.letters.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("comms.letters.intro")}</p>
      </div>
      {done === "sent" ? <TemplateArrival key={at} message={t("comms.letters.sent")} /> : null}
      <Card as="section" title={t("comms.letters.makeTitle")} headingLevel={3}>
        {lettersRefused === "mfa_enrolment_required" ||
        lettersRefused === "mfa_verification_required" ? (
          <p className="m-0">{t("errors.mfaVerifyRequired")}</p>
        ) : (
          <>
            {emailTemplatesLeftOut(templates?.items ?? []) ? (
              <p className="m-0 max-w-prose text-body-dense text-text-secondary">
                {t("comms.letters.emailNotYet")}
              </p>
            ) : null}
            <LetterComposer
              personId={id}
              path={path}
              templates={usable.map((template) => ({
                id: template.id,
                name: templateName(template, t),
                kind: template.kind,
                typed: template.current ? typedFieldsOf(template.current) : [],
              }))}
              incidents={
                incidents
                  ? incidents.items.map((incident) => ({
                      id: incident.id,
                      label: t("comms.letters.incidentOption", {
                        type: incident.type,
                        when: formatDateTime(incident.occurredAt) ?? "",
                      }),
                    }))
                  : null
              }
            />
          </>
        )}
      </Card>
      <Card as="section" title={t("comms.letters.sentTitle")} headingLevel={3}>
        {lettersRefused ? (
          // Never "none sent" when the list could not be read: that could lead to a second letter.
          <p className="m-0">{t("comms.letters.listUnavailable")}</p>
        ) : sent.length === 0 ? (
          <p className="m-0">{t("comms.letters.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {sent.map((letter) => (
              <li key={letter.id} className="flex flex-col gap-1">
                <p className="m-0 font-semibold">
                  {t("comms.letters.sentLine", {
                    channel: letter.channel,
                    when: formatDateTime(letter.sentAt) ?? "",
                    by: letter.sentBy === me.tenantUserId ? "you" : "colleague",
                  })}
                </p>
                {letter.personalFields.length > 0 ? (
                  <p className="m-0 text-body-dense">
                    {t("comms.templates.personalFields", {
                      fields: mergeFieldNames(letter.personalFields),
                    })}
                  </p>
                ) : null}
                {letter.documentId ? (
                  <Link
                    href={`/documents/${letter.documentId}`}
                    className="inline-flex min-h-target items-center self-start underline"
                  >
                    {t("comms.letters.open")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function LettersPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="letters">
      <LettersTab {...props} />
    </RecordFrame>
  );
}

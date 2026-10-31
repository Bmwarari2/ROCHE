import { Card } from "@harbour/ui";
import { Clock, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { HerbertProfileForm } from "@/components/safety-events/HerbertProfileForm";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { HERBERT_TEXT_FIELDS, MISSING_MANAGE, MISSING_READ } from "@/lib/missing";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("herbert");
}

/**
 * The Herbert Protocol profile (SAFE-015): what the police need to find the person if they go
 * missing. Whether it is current or out of date in words; the profile as saved; and for those who
 * manage incidents, the form, prefilled from the record with every part's source named.
 */
async function HerbertTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, MISSING_READ)) return <NoAccess />;
  const api = await tenantApi();
  const data = readOrFail(
    await api.GET("/v1/people/{id}/herbert-profile", { params: { path: { id } } }),
    tabHref(id, "herbert"),
  );
  if (!data) return <NoAccess />;
  const manage = can(me.permissions, MISSING_MANAGE);
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("herbert.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("herbert.intro")}</p>
      </div>
      <Notice
        tone={data.state === "current" ? "info" : "warning"}
        icon={
          data.state === "current" ? (
            <Clock size={20} strokeWidth={1.5} aria-hidden="true" />
          ) : (
            <TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />
          )
        }
        title={t("herbert.state", {
          state: data.state,
          date: formatDate(data.reviewDueOn) ?? "",
        })}
      />
      {data.profile ? (
        <Card as="section" title={t("herbert.saved")} headingLevel={3}>
          <dl className="m-0 flex flex-col gap-3">
            {HERBERT_TEXT_FIELDS.map((field) => (
              <div key={field} className="flex flex-col gap-1">
                <dt className="text-body-dense font-semibold">{t("herbert.field", { field })}</dt>
                <dd className="m-0 whitespace-pre-wrap break-words">
                  {(data.profile?.[field] as string | null) ?? t("herbert.notRecorded")}
                </dd>
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <dt className="text-body-dense font-semibold">{t("herbert.form.reviewedOn")}</dt>
              <dd className="m-0">{formatDate(data.profile.reviewedOn)}</dd>
            </div>
          </dl>
        </Card>
      ) : null}
      {manage ? (
        <Card
          as="section"
          title={data.profile ? t("herbert.update") : t("herbert.create")}
          headingLevel={3}
        >
          <HerbertProfileForm
            personId={id}
            profile={data.profile}
            prefill={data.prefill}
            today={ukToday()}
          />
        </Card>
      ) : null}
    </>
  );
}

export default async function HerbertPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="herbert">
      <HerbertTab {...props} />
    </RecordFrame>
  );
}

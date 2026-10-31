import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("safeguarding");
}

/**
 * The protective measures in place for the person (SAFE-006; HZ-126): what carers must do to keep
 * them safe while a safeguarding concern is open, never the concern itself, who raised it or why.
 * An open concern with no measures recorded is said in words, never shown as nothing.
 */
async function SafeguardingTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.plan.read")) return <NoAccess />;
  const api = await tenantApi();
  const data = readOrFail(
    await api.GET("/v1/people/{id}/safeguarding/measures", { params: { path: { id } } }),
    tabHref(id, "safeguarding"),
  );
  if (!data) return <NoAccess />;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("safeguarding.measures.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("safeguarding.measures.intro")}</p>
      </div>
      <Card as="section" title={t("safeguarding.measures.inPlace")} headingLevel={3}>
        {data.measures.length === 0 ? (
          <p className="m-0">{t("safeguarding.measures.none")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {data.measures.map((m) => (
              <li key={`${m.updatedAt}-${m.text.slice(0, 20)}`} className="flex flex-col gap-1">
                <p className="m-0 whitespace-pre-wrap">{m.text}</p>
                <p className="m-0 text-body-dense text-text-secondary">
                  {t("safeguarding.measures.updated", { when: formatDateTime(m.updatedAt) ?? "" })}
                </p>
              </li>
            ))}
          </ul>
        )}
        {data.openWithoutMeasures > 0 ? (
          <p className="m-0 mt-3 font-semibold">
            {t("safeguarding.measures.openWithout", { count: data.openWithoutMeasures })}
          </p>
        ) : null}
      </Card>
    </>
  );
}

export default async function SafeguardingMeasuresPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="safeguarding">
      <SafeguardingTab {...props} />
    </RecordFrame>
  );
}

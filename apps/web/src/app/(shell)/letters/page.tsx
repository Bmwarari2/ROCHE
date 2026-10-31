import { buttonClassName, Card, EmptyState, PageHeader } from "@harbour/ui";
import { FilePlus, Mail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { TEMPLATE_WRITE, templateName, templatesNavShown, versionChip } from "@/lib/letters";

export const metadata: Metadata = { title: t("comms.templates.title") };

/**
 * Letter and email templates (comms.md rules 18 to 23; COMMS-007): each template with the version
 * in use and any draft waiting for approval. Templates belong to the organisation and hold no
 * personal data; letters are made from them on a person's record.
 */
export default async function TemplatesPage() {
  const { me } = await getShellContext();
  const title = t("comms.templates.title");
  if (!templatesNavShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/letter-templates");
  if (!listed.data) failWith(listed.error, listed.response, "/letters");
  const items = listed.data.items;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("comms.templates.description")}
        primaryAction={
          me.permissions.includes(TEMPLATE_WRITE) ? (
            <Link href="/letters/new" className={buttonClassName({ variant: "primary" })}>
              <FilePlus size={20} strokeWidth={1.5} aria-hidden="true" />
              {t("comms.templates.new")}
            </Link>
          ) : undefined
        }
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Mail size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("comms.templates.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((template) => (
            <li key={template.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-body font-semibold">
                    <Link
                      href={`/letters/${template.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {templateName(template, t)}
                    </Link>
                  </h2>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {t("comms.templates.summary", {
                      kind: template.kind,
                      channel: template.channel,
                    })}
                  </p>
                  <p className="m-0 flex flex-wrap gap-2">
                    {template.current ? (
                      <SafetyChip chip={versionChip("approved", t)} />
                    ) : (
                      <SafetyChip
                        chip={{
                          status: "neutral",
                          icon: "circle-minus",
                          label: t("comms.templates.notInUse"),
                        }}
                      />
                    )}
                    {template.draft ? (
                      <SafetyChip
                        chip={{
                          ...versionChip("draft", t),
                          label: t("comms.templates.draftWaiting", {
                            problems: template.draft.issues.length,
                          }),
                        }}
                      />
                    ) : null}
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

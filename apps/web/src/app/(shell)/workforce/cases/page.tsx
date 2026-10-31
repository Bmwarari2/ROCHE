import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { openCase } from "@/app/actions/workforce";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { CASEWORK, caseStageChip, codeLabel, codeOptions, present, ukDate } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.cases.title") };

const TYPES = ["grievance", "disciplinary", "capability", "sickness_absence", "probation"];

/**
 * Employee relations cases (workforce.md section 2c; WORK-010): a restricted silo (ADR-0089). Only
 * the cases the viewer is named on are listed; a holder of the silo permission may open one. No
 * count or hint of anyone else's cases is shown.
 */
export default async function CasesPage() {
  const { me } = await getShellContext();
  const title = t("workforce.cases.title");
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/cases");
  if (!listed.data) failWith(listed.error, listed.response, "/workforce/cases");
  const opens = me.permissions.includes(CASEWORK);
  const colleagues = opens ? await api.GET("/v1/workforce/colleagues") : null;
  const others = present(colleagues?.data?.items)
    .filter((c) => c.id !== me.tenantUserId)
    .map((c) => ({ value: c.id, label: c.displayName }));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("workforce.cases.description")}
      />
      {listed.data.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("workforce.cases.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {listed.data.items.map((c) => (
            <li key={c.id}>
              <Card>
                <div className="flex flex-col gap-2">
                  <h2 className="m-0 text-body font-semibold">
                    <Link
                      href={`/workforce/cases/${c.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {t("workforce.cases.caseOf", {
                        type: codeLabel("workforce.cases.type", c.caseType, t),
                        name: c.subjectName ?? t("workforce.someone"),
                      })}
                    </Link>
                  </h2>
                  <p className="m-0 text-body-dense text-text-secondary">
                    {t("workforce.cases.openedOn", { date: ukDate(c.openedOn) })}
                  </p>
                  <p className="m-0 flex flex-wrap gap-2">
                    <SafetyChip chip={caseStageChip(c.stage, t)} />
                    {c.suspended ? (
                      <SafetyChip
                        chip={{
                          status: "info",
                          icon: "circle-alert",
                          label: t("workforce.cases.suspended"),
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
      {opens ? (
        <Card>
          <WorkforceForm
            headingLevel={2}
            title={t("workforce.cases.new")}
            intro={t("workforce.cases.newIntro")}
            path="/workforce/cases"
            submit={t("workforce.cases.open")}
            done={t("workforce.cases.opened")}
            action={openCase}
            fields={[
              {
                kind: "select",
                name: "caseType",
                label: t("workforce.cases.typeLabel"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: codeOptions(TYPES, "workforce.cases.type", t),
              },
              {
                kind: "select",
                name: "subjectTenantUserId",
                label: t("workforce.cases.subject"),
                required: true,
                emptyOption: t("workforce.form.choose"),
                options: others,
              },
              {
                kind: "date",
                name: "openedOn",
                label: t("workforce.cases.openedOnLabel"),
                required: true,
              },
              {
                kind: "textarea",
                name: "summary",
                label: t("workforce.cases.summary"),
                hint: t("workforce.cases.summaryHint"),
                required: true,
                maxLength: 10000,
              },
            ]}
          />
        </Card>
      ) : null}
    </div>
  );
}

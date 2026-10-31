import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { FileText } from "lucide-react";
import type { Metadata } from "next";
import { createJobTemplate } from "@/app/actions/workforce";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { WorkforceForm } from "@/components/workforce/WorkforceForm";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";
import { codeLabel, codeOptions, recruitmentShown } from "@/lib/workforce";

export const metadata: Metadata = { title: t("workforce.templates.title") };

const PATHWAY = [
  "new_to_care",
  "care_worker",
  "senior_care_worker",
  "lead_practitioner",
  "deputy_manager",
  "registered_manager",
  "registered_nurse",
];

/**
 * Job templates by Care Workforce Pathway role (workforce.md section 2b; WORK-001): the essential
 * criteria assessed at shortlisting and the values-based questions asked at interview.
 */
export default async function JobTemplatesPage() {
  const { me } = await getShellContext();
  const title = t("workforce.templates.title");
  if (!recruitmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/job-templates");
  if (!listed.data) failWith(listed.error, listed.response, "/workforce/job-templates");
  const items = listed.data.items;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("workforce.templates.description")}
      />
      {items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<FileText size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("workforce.templates.empty")}
          />
        </Card>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {items.map((item) => (
            <li key={item.id}>
              <Card>
                <h2 className="m-0 text-body font-semibold">{item.title}</h2>
                <p className="m-0 text-body-dense text-text-secondary">
                  {t("workforce.templates.summary", {
                    pathway: codeLabel("workforce.pathway", item.pathwayCategory, t),
                    criteria: item.essentialCriteria.length,
                    questions: item.valuesQuestions.length,
                  })}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Card>
        <WorkforceForm
          headingLevel={2}
          title={t("workforce.templates.new")}
          intro={t("workforce.templates.newIntro")}
          path="/workforce/job-templates"
          submit={t("workforce.templates.create")}
          done={t("workforce.templates.created")}
          action={createJobTemplate}
          fields={[
            {
              kind: "text",
              name: "title",
              label: t("workforce.templates.fieldTitle"),
              required: true,
              maxLength: 120,
            },
            {
              kind: "select",
              name: "pathwayCategory",
              label: t("workforce.templates.fieldPathway"),
              required: true,
              emptyOption: t("workforce.form.choose"),
              options: codeOptions(PATHWAY, "workforce.pathway", t),
            },
            {
              kind: "select",
              name: "registrationBody",
              label: t("workforce.templates.fieldRegistration"),
              emptyOption: t("workforce.templates.noRegistration"),
              options: codeOptions(["nmc", "hcpc", "swe", "gmc"], "workforce.registration", t),
            },
            {
              kind: "textarea",
              name: "essentialCriteria",
              label: t("workforce.templates.fieldCriteria"),
              hint: t("workforce.templates.fieldCriteriaHint"),
              required: true,
              maxLength: 4000,
            },
            {
              kind: "textarea",
              name: "valuesQuestions",
              label: t("workforce.templates.fieldQuestions"),
              hint: t("workforce.templates.fieldQuestionsHint"),
              required: true,
              maxLength: 6000,
            },
          ]}
        />
      </Card>
    </div>
  );
}

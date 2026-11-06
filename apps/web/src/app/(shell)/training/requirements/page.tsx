import { BUILTIN_ROLES, TRAINING_TOPICS } from "@harbour/domain";
import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { ListChecks } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { setRequirement } from "@/app/actions/development";
import { DevelopmentForm } from "@/components/development/DevelopmentForm";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { codeLabel, codeOptions, TRAINING } from "@/lib/development";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("development.requirements.title") };

/** Roles for people who are not on the staff: never given training requirements here. */
const PORTAL_OR_VISITOR_ROLES = new Set([
  "family_representative",
  "person_receiving_care",
  "inspector",
  "external_professional",
]);

/**
 * The training each role needs (plan slice 57; WORK-005; workforce.md rule 5): every requirement,
 * by role, with its refresh and, for the Oliver McGowan Mandatory Training, its tier; and a form to
 * set one role's requirement for a topic. For holders of workforce.training.manage.
 */
export default async function TrainingRequirementsPage() {
  const { me } = await getShellContext();
  const title = t("development.requirements.title");
  if (!me.permissions.includes(TRAINING)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/training-requirements");
  if (!listed.data) failWith(listed.error, listed.response, "/training/requirements");
  const items = listed.data.items;
  const builtIn = new Map(BUILTIN_ROLES.map((r) => [r.key, r.name]));
  const roleName = (key: string) => builtIn.get(key) ?? key;
  const roleKeys = [
    ...new Set([
      ...BUILTIN_ROLES.filter((r) => !PORTAL_OR_VISITOR_ROLES.has(r.key)).map((r) => r.key),
      ...items.map((i) => i.roleKey),
    ]),
  ];
  const byRole = [...new Set(items.map((i) => i.roleKey))].sort((a, b) =>
    roleName(a).localeCompare(roleName(b), "en-GB"),
  );
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link href="/training" className="underline">
            {t("development.matrix.title")}
          </Link>
        }
        title={title}
        description={t("development.requirements.description")}
      />
      {byRole.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<ListChecks size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("development.requirements.empty")}
          />
        </Card>
      ) : (
        byRole.map((key) => (
          <Card key={key} as="section" title={roleName(key)} headingLevel={2}>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {items
                .filter((i) => i.roleKey === key)
                .map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {i.tier
                        ? t("development.topicWithTier", {
                            topic: codeLabel("development.topic", i.topic, t),
                            tier: codeLabel("development.tier", String(i.tier), t),
                          })
                        : codeLabel("development.topic", i.topic, t)}
                    </span>
                    <span className="text-body-dense text-text-secondary">
                      {i.refreshYears
                        ? t("development.requirements.refresh", { years: i.refreshYears })
                        : t("development.requirements.defaultRefresh")}
                    </span>
                    {i.active ? null : (
                      <SafetyChip
                        chip={{
                          status: "notApplicable",
                          icon: "circle-minus",
                          label: t("development.requirements.inactive"),
                        }}
                      />
                    )}
                  </li>
                ))}
            </ul>
          </Card>
        ))
      )}
      <Card>
        <DevelopmentForm
          headingLevel={2}
          title={t("development.requirements.new")}
          intro={t("development.requirements.newIntro")}
          path="/training/requirements"
          submit={t("development.requirements.save")}
          done="development.requirements.saved"
          action={setRequirement}
          fields={[
            {
              kind: "select",
              name: "roleKey",
              label: t("development.requirements.role"),
              required: true,
              requiredMessage: t("development.requirements.roleRequired"),
              emptyOption: t("development.form.choose"),
              options: roleKeys.map((k) => ({ value: k, label: roleName(k) })),
            },
            {
              kind: "select",
              name: "topic",
              label: t("development.training.topic"),
              required: true,
              requiredMessage: t("development.training.topicRequired"),
              emptyOption: t("development.form.choose"),
              options: codeOptions(TRAINING_TOPICS, "development.topic", t),
            },
            {
              kind: "text",
              name: "refreshYears",
              label: t("development.requirements.refreshYears"),
              hint: t("development.requirements.refreshYearsHint"),
              inputMode: "numeric",
              maxLength: 2,
            },
            {
              kind: "select",
              name: "tier",
              label: t("development.training.tier"),
              hint: t("development.requirements.tierHint"),
              emptyOption: t("development.training.noTier"),
              options: [
                { value: "1", label: t("development.tier.1") },
                { value: "2", label: t("development.tier.2") },
              ],
            },
            {
              kind: "checkbox",
              name: "active",
              label: t("development.requirements.active"),
              defaultChecked: true,
            },
          ]}
        />
      </Card>
    </div>
  );
}

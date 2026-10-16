import { Card } from "@harbour/ui";
import { tenantApi } from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * The merge fields a template may use (`MERGE_FIELDS`, rule 18), with what each holds and where it
 * may not go, so a writer knows before saving why the API would list a problem.
 */
export async function MergeFieldHelp() {
  const api = await tenantApi();
  const { data } = await api.GET("/v1/merge-fields");
  if (!data) return null;
  return (
    <Card as="section" title={t("comms.templates.fields.title")} headingLevel={2}>
      <p className="m-0 max-w-prose text-body-dense text-text-secondary">
        {t("comms.templates.fields.intro")}
      </p>
      <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
        {data.items.map((field) => (
          <li key={field.key} className="flex flex-col">
            <code className="font-semibold">{`{{${field.key}}}`}</code>
            <span className="text-body-dense">
              {t("comms.templates.fields.line", {
                label: field.label,
                dataClass: field.dataClass,
                notInEmail: field.notInEmail ? "yes" : "no",
              })}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

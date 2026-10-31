import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { NewComplaintForm } from "@/components/safety-silos/ComplaintForms";
import { getShellContext } from "@/lib/api";
import { complaintsShown } from "@/lib/complaints";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("complaints.new") };

/** Recording a complaint (safety.complaint.manage where it is; the API checks the home again). */
export default async function NewComplaintPage() {
  const { me, locationId } = await getShellContext();
  const title = t("complaints.new");
  if (!complaintsShown(me.permissions)) return <SafetyForbidden title={title} />;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader title={title} description={t("complaints.newDescription")} />
      <Card>
        <NewComplaintForm
          locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
          locationId={locationId}
        />
      </Card>
    </div>
  );
}

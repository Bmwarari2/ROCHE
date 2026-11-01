import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TranscribeForm } from "@/components/medicines/MedicineForms";
import { PersonCheck } from "@/components/medicines/PersonCheck";
import { getShellContext } from "@/lib/api";
import { can } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import { MEDICINES_WRITER, medicinesHref } from "@/lib/medicines";
import { getPerson } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.new.title"));
}

/**
 * Transcribing a medicine from its source (medicines.md section 13 rule 3): the product from dm+d,
 * the route and unit dm+d permits, the directions, dates, prescriber and source. The entry is
 * recorded as not yet checked until a second person checks it.
 */
async function NewMedicine({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, MEDICINES_WRITER)) return <NoAccess />;
  return (
    <>
      <Card as="section" title={t("medicines.new.title")} headingLevel={2}>
        <TranscribeForm personId={id} person={<PersonCheck person={person} />} />
      </Card>
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.back")}
        </Link>
      </p>
    </>
  );
}

export default async function NewMedicinePage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <NewMedicine {...props} />
    </RecordFrame>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { PrintButton } from "@/components/cd/PrintButton";
import { RegisterEntries, StockChecks } from "@/components/cd/Register";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { cdPageHref, cdShown } from "@/lib/controlled-drugs";
import { formatDate, formatDateTime, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";

export const metadata: Metadata = { title: t("cd.print.title") };

/**
 * A register page to print (MEDS-005, MEDS-014; medicines.md section 15 rule 7). Slice 50's
 * printable register format does not exist yet, so this is a plain view: who it is for, the drug,
 * form, strength and unit, the balance as the API reports it, every entry with its signatures
 * (recorder and witness by name, or why no witness) and each correction under the entry it
 * corrects, and the counts, with the time it was printed. Reading it is audited by the API as a
 * view of the page.
 */
export default async function PrintCdPage({
  params,
}: {
  readonly params: Promise<{ id: string; pageId: string }>;
}) {
  const { id, pageId } = await params;
  if (!isUuid(id) || !isUuid(pageId)) notFound();
  const { me } = await getShellContext();
  if (!cdShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const [{ person }, read] = await Promise.all([
    getPerson(id),
    api.GET("/v1/controlled-drugs/pages/{pageId}", { params: { path: { pageId } } }),
  ]);
  const page = read.data;
  if (!person || !page || page.personId !== id) notFound();
  const printedAt = formatDateTime(new Date().toISOString()) ?? "";

  return (
    <main className="mx-auto flex max-w-content flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href={cdPageHref(id, pageId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("cd.print.back")}
        </Link>
        <PrintButton />
      </div>
      <header className="flex flex-col gap-1 border-b border-border pb-3">
        <h1 className="m-0 text-title">{t("cd.print.heading", { product: page.productName })}</h1>
        <p className="m-0">
          {t("cd.print.person", {
            name: personNames(person).full,
            born: formatDate(person.dateOfBirth) ?? t("cd.print.noBirthDate"),
            nhs: formatNhsNumber(person.nhsNumber) ?? t("cd.print.noNhs"),
          })}
        </p>
        <p className="m-0">{t("cd.print.unit", { unit: page.unit.name })}</p>
        <p className="m-0 font-semibold">
          {t("cd.balance", { balance: page.balance, unit: page.unit.name })}
        </p>
        <p className="m-0 text-body-dense">
          {t("cd.print.printed", { when: printedAt, organisation: me.tenant.name })}
        </p>
      </header>
      <section aria-labelledby="print-entries" className="flex flex-col gap-2">
        <h2 id="print-entries" className="m-0 text-body font-semibold">
          {t("cd.page.entries")}
        </h2>
        <RegisterEntries page={page} />
      </section>
      <section aria-labelledby="print-checks" className="flex flex-col gap-2">
        <h2 id="print-checks" className="m-0 text-body font-semibold">
          {t("cd.page.checks")}
        </h2>
        <StockChecks page={page} />
      </section>
      <p className="m-0 text-body-dense">{t("cd.print.footer")}</p>
    </main>
  );
}

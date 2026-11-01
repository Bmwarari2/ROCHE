import { Card, StatusChip } from "@harbour/ui";
import { CircleCheck, Hourglass } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { PersonCheck } from "@/components/medicines/PersonCheck";
import {
  AddItemForm,
  AddSourceForm,
  CompleteForm,
  EntryDecisionForm,
  ItemDecisionForm,
} from "@/components/medicines/ReconciliationForms";
import { getShellContext, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { decisionFor, MEDICINES_WRITER, medicinesHref, medicinesShown } from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; recId: string }>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.rec.title"));
}

const decisionWords = (d: { readonly kind: string } | null, on: "entry" | "item") =>
  d
    ? t(on === "entry" ? "medicines.rec.entryDecision" : "medicines.rec.itemDecision", {
        kind: d.kind,
      })
    : t("medicines.rec.undecided");

/**
 * A reconciliation (medicines.md section 13 rule 6), in order: the sources, the lines from each as
 * written, a decision by a person for every current entry and every line no entry answers, then
 * completion. Harbour decides nothing: a line that says "stop" stops nothing until a person decides
 * it, and completion applies the decisions only when the API's rules pass.
 */
async function ReconciliationTab({ params }: { readonly params: Params }) {
  const { id, recId } = await params;
  if (!isUuid(recId)) notFound();
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!medicinesShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const [recRead, recordRead] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-reconciliations/{recId}", {
      params: { path: { id, recId } },
    }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
  ]);
  const rec = readOrFail(recRead, medicinesHref(id));
  const record = readOrFail(recordRead, medicinesHref(id));
  if (!rec || !record) return <NoAccess />;
  const open = rec.status === "open";
  const writer = can(me.permissions, MEDICINES_WRITER) && open;
  const when = (iso: string | null) => formatDateTime(iso) ?? "";
  const allergies = <PersonCheck person={person} />;
  const sourceLabel = (s: (typeof rec.sources)[number]) =>
    t("medicines.rec.sourceLabel", {
      kind: t("medicines.sourceKind", { kind: s.kind }),
      reference: s.reference,
      when: when(s.receivedAt),
    });
  const sources = rec.sources.map((s) => ({ id: s.id, label: sourceLabel(s) }));
  const lineLabel = (i: (typeof rec.items)[number]) =>
    t("medicines.rec.lineLabel", {
      says: t("medicines.rec.saysOption", { says: i.says }),
      asWritten: i.asWritten,
    });
  const lines = rec.items.map((i) => ({ id: i.id, label: lineLabel(i) }));
  const atStart = new Set(rec.entriesAtStart.map((e) => e.entryId));
  const entries = record.entries.filter((e) => atStart.has(e.id));

  return (
    <>
      <Card as="section" title={t("medicines.rec.title")} headingLevel={2}>
        <div className="flex flex-col gap-2">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <StatusChip
              status={open ? "due" : "done"}
              label={t("medicines.rec.status", { status: rec.status })}
              icon={open ? Hourglass : CircleCheck}
            />
            <span>
              {t("medicines.rec.trigger", { kind: rec.trigger, when: when(rec.triggeredAt) })}
            </span>
          </p>
          <p className="m-0 max-w-prose">{t("medicines.rec.never")}</p>
        </div>
      </Card>

      <Card as="section" title={t("medicines.rec.sourcesTitle")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {sources.length === 0 ? (
            <p className="m-0">{t("medicines.rec.noSources")}</p>
          ) : (
            <ul className="m-0 flex flex-col gap-2 pl-5">
              {rec.sources.map((s) => (
                <li key={s.id}>
                  {sourceLabel(s)}
                  {s.currentBecause
                    ? ` ${t("medicines.rec.currentNote", { why: s.currentBecause })}`
                    : ""}
                </li>
              ))}
            </ul>
          )}
          {writer ? (
            <section aria-labelledby="add-source" className="flex flex-col gap-3">
              <h4 id="add-source" className="m-0 text-body font-semibold">
                {t("medicines.rec.addSource")}
              </h4>
              <AddSourceForm personId={id} recId={recId} />
            </section>
          ) : null}
        </div>
      </Card>

      <Card as="section" title={t("medicines.rec.linesTitle")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          {lines.length === 0 ? (
            <p className="m-0">{t("medicines.rec.noLines")}</p>
          ) : (
            <ul className="m-0 flex flex-col gap-2 pl-5">
              {rec.items.map((i) => (
                <li key={i.id}>
                  {lineLabel(i)}
                  {i.product ? ` (${i.product.name})` : ""}
                </li>
              ))}
            </ul>
          )}
          {writer && sources.length > 0 ? (
            <section aria-labelledby="add-line" className="flex flex-col gap-3">
              <h4 id="add-line" className="m-0 text-body font-semibold">
                {t("medicines.rec.addLine")}
              </h4>
              <AddItemForm personId={id} recId={recId} sources={sources} allergies={allergies} />
            </section>
          ) : null}
        </div>
      </Card>

      <Card as="section" title={t("medicines.rec.entriesTitle")} headingLevel={3}>
        {entries.length === 0 ? (
          <p className="m-0">{t("medicines.rec.noEntries")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {entries.map((e) => {
              const decided = decisionFor(rec, { entryId: e.id });
              return (
                <li key={e.id} className="flex flex-col gap-3 border-b border-border pb-4">
                  <h4 className="m-0 text-body font-semibold">{e.product.name}</h4>
                  <p className="m-0 text-body-dense">{e.directionsInWords}</p>
                  <p className="m-0 font-semibold">
                    {t("medicines.rec.decision", { words: decisionWords(decided, "entry") })}
                  </p>
                  {writer ? (
                    <EntryDecisionForm
                      personId={id}
                      recId={recId}
                      entryId={e.id}
                      lines={lines}
                      allergies={allergies}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {rec.items.length > 0 ? (
        <Card as="section" title={t("medicines.rec.itemsTitle")} headingLevel={3}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("medicines.rec.itemsAbout")}</p>
            <ul className="m-0 flex list-none flex-col gap-6 p-0">
              {rec.items.map((i) => {
                const decided = decisionFor(rec, { itemId: i.id });
                return (
                  <li key={i.id} className="flex flex-col gap-3 border-b border-border pb-4">
                    <h4 className="m-0 text-body font-semibold">{lineLabel(i)}</h4>
                    <p className="m-0 font-semibold">
                      {t("medicines.rec.decision", { words: decisionWords(decided, "item") })}
                    </p>
                    {writer ? (
                      <ItemDecisionForm
                        personId={id}
                        recId={recId}
                        itemId={i.id}
                        allergies={allergies}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </Card>
      ) : null}

      {writer ? (
        <Card as="section" title={t("medicines.rec.completeTitle")} headingLevel={3}>
          <CompleteForm
            personId={id}
            recId={recId}
            version={rec.version}
            isReturn={rec.trigger === "return_from_hospital"}
            allergies={allergies}
          />
        </Card>
      ) : rec.completed ? (
        <p className="m-0">{t("medicines.rec.completedOn", { when: when(rec.completed.at) })}</p>
      ) : null}
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.back")}
        </Link>
      </p>
    </>
  );
}

export default async function ReconciliationPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <ReconciliationTab {...props} />
    </RecordFrame>
  );
}

import { Card, EmptyState } from "@harbour/ui";
import { ClipboardList } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { NoteForm } from "@/components/care/NoteForm";
import { NoteList } from "@/components/care/NoteList";
import { WindowNote } from "@/components/care/WindowNote";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, readingWindow, tabHref, windowStart } from "@/lib/care-record";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { ukDateTimeInput } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("notes");
}

/** Daily notes (care.md rules 3 and 4; register row CARE-009). */
export default async function NotesPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.note.read")) return <NoAccess />;

  const days = readingWindow((await searchParams).days);
  const path = tabHref(id, "notes");
  const api = await tenantApi();
  const list = readOrFail(
    await api.GET("/v1/people/{id}/notes", {
      params: { path: { id }, query: { from: windowStart(days) } },
    }),
    path,
  );
  if (!list) return <NoAccess />;
  const names = personNames(person);
  const canWrite = can(me.permissions, "care.note.write");

  return (
    <>
      <h2 className="m-0 text-eyebrow">{t("care.notes.title")}</h2>
      {canWrite ? (
        <Card as="section" title={t("care.notes.form.title")} headingLevel={3}>
          <NoteForm personId={id} nowLocal={ukDateTimeInput()} />
        </Card>
      ) : null}
      <section aria-labelledby="notes-list" className="flex flex-col gap-4">
        <h3 id="notes-list" className="m-0 text-body font-semibold">
          {t("care.notes.listLabel", { name: names.preferred })}
        </h3>
        <WindowNote days={days} href={path} />
        {list.items.length === 0 ? (
          <EmptyState
            headingLevel={4}
            icon={<ClipboardList size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("care.notes.empty", { days })}
            description={t("people.notes.emptyBody", { name: names.preferred })}
          />
        ) : (
          <NoteList
            notes={list.items}
            label={t("care.notes.listLabel", { name: names.preferred })}
            personId={id}
            tenantUserId={me.tenantUserId}
            canWrite={canWrite}
          />
        )}
      </section>
    </>
  );
}

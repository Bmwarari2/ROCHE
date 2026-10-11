import { EmptyState, InspectorPanel } from "@harbour/ui";
import { ClipboardList, Lock, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreakGlass } from "@/components/people/BreakGlass";
import { PersonHeader } from "@/components/people/PersonHeader";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { peopleLabel, t } from "@/lib/i18n";
import { canBreakGlass, personNames } from "@/lib/people";

type Params = Promise<{ id: string }>;

async function loadPerson(id: string) {
  if (!isUuid(id)) return { person: null, code: "not_found" } as const;
  const api = await tenantApi();
  const { data, error, response } = await api.GET("/v1/people/{id}", {
    params: { path: { id } },
  });
  if (data) return { person: data, code: null } as const;
  const code = problemCode(error);
  if (code === "not_found" || code === "missing_permission" || response.status === 404) {
    return { person: null, code: code ?? "not_found" } as const;
  }
  return failWith(error, response, `/people/${id}`);
}

export async function generateMetadata({ params }: { readonly params: Params }): Promise<Metadata> {
  // The title names the module, not the person: browser history and tab titles are visible to
  // anyone who uses the computer next.
  const { me } = await getShellContext();
  await params;
  return { title: peopleLabel(me.tenant.terminology) };
}

/** One person's point-of-care view. Phase 1 fills the panels with care plans, notes and medicines. */
export default async function PersonPage({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { me } = await getShellContext();
  const { person, code } = await loadPerson(id);
  const people = peopleLabel(me.tenant.terminology);

  if (!person) {
    const forbidden = code === "missing_permission";
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-6 py-6">
        <EmptyState
          headingLevel={1}
          icon={
            forbidden ? (
              <Lock size={40} strokeWidth={1.5} aria-hidden="true" />
            ) : (
              <SearchX size={40} strokeWidth={1.5} aria-hidden="true" />
            )
          }
          title={forbidden ? t("errors.forbidden") : t("errors.notFound")}
          description={
            forbidden
              ? undefined
              : "This record does not exist, or it is outside your access. Records outside your access can be opened only with a reason, which is recorded and shared with your Registered Manager."
          }
          action={
            !forbidden && canBreakGlass(me.permissions) ? (
              <BreakGlass
                personId={id}
                labels={{
                  title: t("people.breakGlass.title"),
                  body: t("people.breakGlass.body"),
                  justification: t("people.breakGlass.justification"),
                  cancel: t("common.cancel"),
                  stepUpTitle: t("auth.stepUp.title"),
                  stepUpBody: t("auth.stepUp.body"),
                }}
              />
            ) : null
          }
          secondaryAction={
            <Link href="/people" className="hb-button hb-button--tertiary">
              <span className="hb-button__label">Back to {people.toLocaleLowerCase("en-GB")}</span>
              <span className="hb-button__chevron" aria-hidden="true">
                ›
              </span>
            </Link>
          }
        />
      </div>
    );
  }

  const location = me.locations.find((l) => l.id === person.locationId);
  const names = personNames(person);

  return (
    <div className="flex w-full flex-col gap-6">
      <nav aria-label="Breadcrumb" className="text-callout">
        <Link href="/people">{people}</Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{names.hasPreferred ? names.preferred : names.full}</span>
      </nav>
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <PersonHeader person={person} locationName={location?.name ?? null} />
          <EmptyState
            headingLevel={2}
            icon={<ClipboardList size={32} strokeWidth={1.5} aria-hidden="true" />}
            title="No care notes yet"
            description={`Notes written by the team about ${names.preferred} will appear here.`}
          />
        </div>
        <InspectorPanel
          title={`About ${names.preferred}`}
          subtitle="Care plan, medicines and risk assessments"
          className="md:w-[360px] md:shrink-0"
        >
          <p className="m-0 text-callout text-text-secondary">
            Care plans, medicines and risk assessments will appear here once they are recorded in
            Harbour.
          </p>
        </InspectorPanel>
      </div>
    </div>
  );
}

import { EmptyState, InspectorPanel } from "@harbour/ui";
import { ClipboardList, Lock, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { BreakGlass } from "@/components/people/BreakGlass";
import { PersonHeader } from "@/components/people/PersonHeader";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { peopleLabel, t } from "@/lib/i18n";
import {
  BREAK_GLASS_MAX_LENGTH,
  BREAK_GLASS_MIN_LENGTH,
  canBreakGlass,
  personNames,
} from "@/lib/people";

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
          description={forbidden ? undefined : t("people.notFound.body")}
          action={
            !forbidden && canBreakGlass(me.permissions) ? (
              <BreakGlass
                personId={id}
                labels={{
                  title: t("people.breakGlass.title"),
                  body: t("people.breakGlass.body"),
                  justification: t("people.breakGlass.justification"),
                  hint: t("people.breakGlass.hint", { min: BREAK_GLASS_MIN_LENGTH }),
                  submit: t("people.breakGlass.submit"),
                  cancel: t("common.cancel"),
                  close: t("common.close"),
                  stepUpTitle: t("auth.stepUp.title"),
                  stepUpBody: t("auth.stepUp.body"),
                  stepUpReason: t("people.breakGlass.stepUpReason"),
                  signInAgain: t("people.breakGlass.signInAgain"),
                  failure: {
                    "too-short": t("people.breakGlass.tooShort", { min: BREAK_GLASS_MIN_LENGTH }),
                    "too-long": t("people.breakGlass.tooLong", { max: BREAK_GLASS_MAX_LENGTH }),
                    forbidden: t("people.breakGlass.forbidden"),
                    "not-found": t("people.breakGlass.notFound"),
                    unavailable: t("people.breakGlass.unavailable"),
                  },
                }}
              />
            ) : null
          }
          secondaryAction={
            <Link href="/people" className="hb-button hb-button--tertiary">
              <span className="hb-button__label">
                {t("people.list.back", { terminology: me.tenant.terminology })}
              </span>
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
      <nav aria-label={t("common.breadcrumb")} className="text-callout">
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
            title={t("people.notes.emptyTitle")}
            description={t("people.notes.emptyBody", { name: names.preferred })}
          />
        </div>
        <InspectorPanel
          title={t("people.about.title", { name: names.preferred })}
          subtitle={t("people.about.subtitle")}
          className="md:w-[360px] md:shrink-0"
        >
          <p className="m-0 text-callout text-text-secondary">{t("people.about.empty")}</p>
        </InspectorPanel>
      </div>
    </div>
  );
}

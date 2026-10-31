"use client";

import type { SearchResultItem, SearchResults } from "@harbour/contracts";
import { Button, Checkbox, SelectField, TextField } from "@harbour/ui";
import { CircleAlert, Search } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { runSearch } from "@/app/actions/search";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { PersonStatusBadge } from "@/components/exit/ExitChip";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { SampleBadge } from "@/components/people/SampleBadge";
import { formatDate, formatDateTime, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, refused } from "@/lib/outcome";
import {
  initialsOf,
  resultHref,
  SEARCH_KINDS,
  SEARCH_MAX_LENGTH,
  type SearchKind,
  scopeStatement,
} from "@/lib/search";

/**
 * The search box (PLAT-013; HZ-001, HZ-011). Typing and Enter search; the words are sent to the API
 * in the request body and never put in the address. Results take focus at their heading and say
 * where the search looked, what was left out and why, and when two people share a name; each
 * person shows their photo, date of birth (or age) and status as an icon and a word, so the right
 * person is chosen before a record opens.
 */
export function SearchBox({ mayIncludeArchived }: { readonly mayIncludeArchived: boolean }) {
  const ids = useFieldIds(["query", "kind", "archived"]);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind>("all");
  const [archived, setArchived] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [searchedFor, setSearchedFor] = useState(0);
  const [pending, startTransition] = useTransition();
  const heading = useRef<HTMLHeadingElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each new search takes focus again.
  useEffect(() => {
    if (results) heading.current?.focus();
  }, [searchedFor]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim()) {
      setResult(refused(t("platform.search.empty"), "invalid", ["query"]));
      setResults(null);
      return;
    }
    startTransition(async () => {
      const outcome = await runSearch({ query, kind, includeArchived: archived });
      setResult(outcome.ok ? null : outcome);
      setResults(outcome.ok ? outcome.data : null);
      setSearchedFor((n) => n + 1);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <search>
        {/* POST, so that pressing Enter before the page's scripts have loaded never puts the
            words in the address: they stay in the request body (#94 review). */}
        <form method="post" className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <TextField
            id={ids.query}
            name="query"
            type="search"
            label={t("platform.search.label")}
            hint={t("platform.search.hint")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={SEARCH_MAX_LENGTH}
            autoComplete="off"
            error={errorFor(result, "query")}
          />
          <SelectField
            id={ids.kind}
            name="kind"
            label={t("platform.search.kind")}
            value={kind}
            onChange={(event) => setKind(event.target.value as SearchKind)}
            options={SEARCH_KINDS.map((value) => ({
              value,
              label: t("platform.search.kindOption", { kind: value }),
            }))}
          />
          {mayIncludeArchived ? (
            <Checkbox
              id={ids.archived}
              name="archived"
              label={t("platform.search.includeArchived")}
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />
          ) : null}
          <div>
            <Button
              type="submit"
              icon={<Search size={20} strokeWidth={1.5} aria-hidden="true" />}
              disabled={pending}
            >
              {t("platform.search.submit")}
            </Button>
          </div>
          <p role="status" className="m-0 min-h-6 text-body-dense">
            {pending ? t("platform.search.searching") : ""}
          </p>
          <FormFeedback result={result} success="" fieldIds={ids} />
        </form>
      </search>
      {results ? <ResultList results={results} heading={heading} /> : null}
    </div>
  );
}

function ResultList({
  results,
  heading,
}: {
  readonly results: SearchResults;
  readonly heading: React.RefObject<HTMLHeadingElement | null>;
}) {
  const scope = scopeStatement(results);
  return (
    <section aria-labelledby="search-results" className="flex flex-col gap-4">
      <h2 id="search-results" ref={heading} tabIndex={-1} className="m-0 text-body font-semibold">
        {t("platform.search.resultsTitle", { count: results.total })}
      </h2>
      <div className="flex flex-col gap-1 text-body-dense text-text-secondary">
        {scope.person ? (
          <p className="m-0">{t("platform.search.personScope", { scope: scope.person })}</p>
        ) : null}
        {scope.staff ? (
          <p className="m-0">{t("platform.search.staffScope", { scope: scope.staff })}</p>
        ) : null}
        <p className="m-0">
          {t("platform.search.archivedScope", { included: scope.includeArchived ? "yes" : "no" })}
        </p>
        {scope.omitted.map((o) => (
          <p key={o.type} className="m-0">
            {t("platform.search.omitted", { kind: o.type, reason: o.reason })}
          </p>
        ))}
        {results.ignoredTerms > 0 ? (
          <p className="m-0">{t("platform.search.ignored", { count: results.ignoredTerms })}</p>
        ) : null}
        {results.capped ? (
          <p className="m-0">{t("platform.search.capped", { limit: results.readLimit })}</p>
        ) : results.hasMore ? (
          <p className="m-0">{t("platform.search.more")}</p>
        ) : null}
      </div>
      {results.items.length === 0 ? (
        <p className="m-0">{t("platform.search.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {results.items.map((item) => (
            <li key={`${item.type}:${item.id}`} className="border-b border-border pb-3">
              <ResultRow item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ResultTitle({ item, text }: { readonly item: SearchResultItem; readonly text: string }) {
  const href = resultHref(item);
  return href ? (
    <Link href={href} className="inline-flex min-h-target items-center font-semibold underline">
      {text}
    </Link>
  ) : (
    <p className="m-0 font-semibold">{text}</p>
  );
}

function ResultRow({ item }: { readonly item: SearchResultItem }) {
  const kind = t("platform.search.kindLabel", { kind: item.type });
  if (item.person) {
    const p = item.person;
    return (
      <div className="flex items-start gap-3">
        <PersonAvatar personId={p.id} initials={initialsOf(p.name)} hasPhoto={p.hasPhoto} alt="" />
        <div className="flex flex-col gap-1">
          <ResultTitle
            item={item}
            text={
              p.preferredName
                ? t("platform.search.nameKnownAs", { name: p.name, preferred: p.preferredName })
                : p.name
            }
          />
          <p className="m-0 text-body-dense">
            {[
              p.dateOfBirth
                ? t("platform.search.born", { date: formatDate(p.dateOfBirth) ?? "" })
                : p.age !== null
                  ? t("platform.search.age", { age: p.age })
                  : null,
              p.nhsNumber
                ? t("platform.search.nhs", { nhs: formatNhsNumber(p.nhsNumber) ?? "" })
                : null,
              p.locationName,
              p.roomLabel ? t("platform.search.room", { room: p.roomLabel }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <SampleBadge sample={p.sample} />
            <PersonStatusBadge status={p.status} always />
          </div>
          {p.communicationNeeds.length > 0 ? (
            <p className="m-0 text-body-dense">
              {t("platform.search.communication", { needs: p.communicationNeeds.join("; ") })}
            </p>
          ) : null}
          {item.sameName ? (
            <p className="m-0 flex items-start gap-2 rounded-input border-s-4 border-warning bg-bg-secondary p-2 font-semibold">
              <CircleAlert
                size={20}
                strokeWidth={1.5}
                aria-hidden="true"
                className="mt-0.5 shrink-0"
              />
              {t("platform.search.sameName", { check: p.dateOfBirth ? "dob" : "age" })}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  if (item.staff) {
    return (
      <div className="flex flex-col gap-1">
        <ResultTitle item={item} text={item.staff.name} />
        <p className="m-0 text-body-dense">
          {kind}
          {item.staff.roles.length > 0 ? ` · ${item.staff.roles.join(", ")}` : ""}
          {item.staff.locations.length > 0 ? ` · ${item.staff.locations.join(", ")}` : ""}
        </p>
      </div>
    );
  }
  if (item.document) {
    const d = item.document;
    return (
      <div className="flex flex-col gap-1">
        <ResultTitle item={item} text={d.title} />
        <p className="m-0 text-body-dense">
          {[kind, d.personName, d.fileName, formatDateTime(d.createdAt)]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    );
  }
  if (item.note) {
    const n = item.note;
    return (
      <div className="flex flex-col gap-1">
        <ResultTitle item={item} text={t("platform.search.noteTitle", { name: n.personName })} />
        <p className="m-0">{n.excerpt}</p>
        <p className="m-0 text-body-dense">
          {[formatDateTime(n.occurredAt), n.author].filter(Boolean).join(" · ")}
        </p>
      </div>
    );
  }
  return null;
}

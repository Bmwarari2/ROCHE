import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { BreakGlassSearch } from "@/components/search/BreakGlassSearch";
import { SearchBox } from "@/components/search/SearchBox";
import { getShellContext } from "@/lib/api";
import { t } from "@/lib/i18n";
import { breakGlassSearchShown, SEARCH_ARCHIVED, searchShown } from "@/lib/search";

export const metadata: Metadata = { title: t("platform.search.title") };

/**
 * Search (PLAT-013; platform-completions.md rules 1 to 8): what the user can already see, in the
 * scope each kind of record rests on. The words typed never go in this page's address.
 */
export default async function SearchPage() {
  const { me } = await getShellContext();
  const title = t("platform.search.title");
  if (!searchShown(me.permissions)) return <SafetyForbidden title={title} />;
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("platform.search.intro")} />
      <Card>
        <SearchBox mayIncludeArchived={me.permissions.includes(SEARCH_ARCHIVED)} />
      </Card>
      {breakGlassSearchShown(me.permissions) ? (
        <Card as="section" title={t("platform.breakGlassSearch.cardTitle")} headingLevel={2}>
          <div className="flex flex-col gap-3">
            <p className="m-0 max-w-prose">{t("platform.breakGlassSearch.cardBody")}</p>
            <div>
              <BreakGlassSearch />
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

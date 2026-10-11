import type { BodyMapMarkItem } from "@harbour/contracts";
import { Card } from "@harbour/ui";
import type { Metadata } from "next";
import { BodyMapRecorder } from "@/components/care/BodyMapRecorder";
import { EntryBadges } from "@/components/care/EntryBadges";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson, readOrFail } from "@/lib/person-record";
import { recordMetadata } from "@/lib/record-metadata";
import { ukDateTimeInput } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;

function sizeText(mark: BodyMapMarkItem): string {
  if (mark.lengthMm !== null && mark.widthMm !== null) {
    return t("care.bodyMap.marks.sizeValue", { length: mark.lengthMm, width: mark.widthMm });
  }
  return t("common.notRecorded");
}

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("body-map");
}

/**
 * The body map tab (care.md rule 7; register row CARE-012; hazard HZ-019): record a mark on the
 * drawing or from the list with the side confirmed in words, and see the marks that have not
 * healed, on the drawing and in a table.
 */
async function BodyMapTab({ params }: { readonly params: Params }) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "care.note.read")) return <NoAccess />;
  const api = await tenantApi();
  const list = readOrFail(
    await api.GET("/v1/people/{id}/body-map", {
      params: { path: { id }, query: { includeHealed: "false" } },
    }),
    tabHref(id, "body-map"),
  );
  if (!list) return <NoAccess />;
  const names = personNames(person);
  const drawn = (view: "front" | "back") =>
    list.items
      .filter((mark) => mark.view === view)
      .map((mark) => ({ id: mark.id, region: mark.region, side: mark.side }));

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("care.bodyMap.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">
          {t("care.bodyMap.description", { name: names.preferred })}
        </p>
      </div>
      {can(me.permissions, "care.note.write") ? (
        <Card as="section" title={t("care.bodyMap.form.title")} headingLevel={3}>
          <BodyMapRecorder
            personId={id}
            nowLocal={ukDateTimeInput()}
            marks={{ front: drawn("front"), back: drawn("back") }}
          />
        </Card>
      ) : null}
      <section aria-labelledby="current-marks" className="flex flex-col gap-3">
        <h3 id="current-marks" className="m-0 text-body font-semibold">
          {t("care.bodyMap.marks.title")}
        </h3>
        {list.items.length === 0 ? (
          <p className="m-0 text-text-secondary">{t("care.bodyMap.marks.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-callout">
              <caption className="hb-visually-hidden">
                {t("care.bodyMap.marks.caption", { name: names.preferred })}
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.bodyMap.marks.where")}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.bodyMap.marks.type")}
                  </th>
                  <th scope="col" className="py-2 pe-4 text-start font-semibold">
                    {t("care.bodyMap.marks.size")}
                  </th>
                  <th scope="col" className="py-2 text-start font-semibold">
                    {t("care.bodyMap.marks.recorded")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((mark) => (
                  <tr
                    key={mark.id}
                    className="border-b border-border align-top last:border-b-0"
                    data-mark-row={`${mark.view}.${mark.region}.${mark.side}`}
                  >
                    <th scope="row" className="py-2 pe-4 text-start font-normal">
                      {t("care.bodyMap.marks.place", {
                        region: t("care.bodyMap.regionName", { region: mark.region }),
                        side: mark.side,
                        view: mark.view,
                      })}
                    </th>
                    <td className="py-2 pe-4">
                      <span className="block">
                        {t("care.bodyMap.markTypeOption", { type: mark.markType })}
                      </span>
                      {mark.pressureCategory ? (
                        <span className="block font-semibold">
                          {t("care.bodyMap.categoryShort", { category: mark.pressureCategory })}
                        </span>
                      ) : null}
                      {mark.description ? (
                        <span className="block text-text-secondary">{mark.description}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pe-4">{sizeText(mark)}</td>
                    <td className="py-2">
                      <span className="block tabular-nums">{formatDateTime(mark.occurredAt)}</span>
                      <span className="flex flex-wrap gap-1">
                        <EntryBadges entry={mark} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab, and the tabs. */
export default async function BodyMapPage(props: { readonly params: Params }) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="body-map">
      <BodyMapTab {...props} />
    </RecordFrame>
  );
}

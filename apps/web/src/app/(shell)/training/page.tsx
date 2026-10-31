import { BUILTIN_ROLES } from "@harbour/domain";
import {
  Button,
  ButtonLink,
  Card,
  Checkbox,
  EmptyState,
  PageHeader,
  SelectField,
} from "@harbour/ui";
import { GraduationCap } from "lucide-react";
import type { Metadata } from "next";
import { type MatrixRow, TrainingMatrixGrid } from "@/components/development/TrainingMatrixGrid";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  codeLabel,
  developmentShown,
  matrixCounts,
  TRAINING,
  trainingChip,
  ukDate,
} from "@/lib/development";
import { t } from "@/lib/i18n";
import { firstParam } from "@/lib/record-metadata";

export const metadata: Metadata = { title: t("development.matrix.title") };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Roles for people who are not on the staff: never a filter on the training matrix. */
const PORTAL_OR_VISITOR_ROLES = new Set([
  "family_representative",
  "person_receiving_care",
  "inspector",
  "external_professional",
]);

/**
 * The organisation's training matrix (plan slice 57; WORK-005): every member of staff whose roles
 * need training, each required topic's state today as an icon and a word, filtered by location,
 * role and to those needing attention. Large homes' matrices are windowed (TrainingMatrixGrid).
 * Each name opens the member's record. Holders of the training permission set each role's
 * requirements.
 */
export default async function TrainingMatrixPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me } = await getShellContext();
  const title = t("development.matrix.title");
  if (!developmentShown(me.permissions)) return <SafetyForbidden title={title} />;
  const raw = await searchParams;
  const locationId = firstParam(raw.location);
  const roleKey = firstParam(raw.role);
  const attention = firstParam(raw.attention) === "yes";
  const api = await tenantApi();
  const matrix = await api.GET("/v1/workforce/training-matrix", {
    params: {
      query: {
        ...(locationId && isUuid(locationId) ? { locationId } : {}),
        ...(roleKey && /^[a-z0-9_]{1,80}$/.test(roleKey) ? { roleKey } : {}),
        ...(attention ? { attention: "true" as const } : {}),
      },
    },
  });
  if (!matrix.data) failWith(matrix.error, matrix.response, "/training");
  const { members, topics, truncated, asOf } = matrix.data;
  const columns = topics.map((topic) => ({
    topic,
    label: codeLabel("development.topic", topic, t),
  }));
  const rows: MatrixRow[] = members
    .flatMap((m) => (m.member ? [{ ...m, member: m.member }] : []))
    .map((m) => ({
      id: m.member.id,
      href: `/training/${m.member.id}`,
      name: m.member.displayName,
      jobTitle: m.member.jobTitle,
      cells: Object.fromEntries(
        m.cells.map((cell) => [
          cell.topic,
          {
            chip: trainingChip(cell.status, t),
            until: cell.validUntil
              ? t("development.matrix.until", { date: ukDate(cell.validUntil) })
              : "",
          },
        ]),
      ),
    }));
  const counts = matrixCounts(members);
  const roles = BUILTIN_ROLES.filter((r) => !PORTAL_OR_VISITOR_ROLES.has(r.key));
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={me.tenant.name}
        title={title}
        description={t("development.matrix.description", { date: ukDate(asOf) })}
        {...(me.permissions.includes(TRAINING)
          ? {
              secondaryActions: (
                <ButtonLink href="/training/requirements" variant="secondary">
                  {t("development.requirements.title")}
                </ButtonLink>
              ),
            }
          : {})}
      />
      <Card as="section" title={t("development.matrix.filter")} headingLevel={2}>
        <form method="get" action="/training" className="flex flex-wrap items-end gap-4">
          <SelectField
            name="location"
            label={t("development.matrix.location")}
            emptyOption={t("development.matrix.anyLocation")}
            defaultValue={locationId ?? ""}
            options={me.locations.map((l) => ({ value: l.id, label: l.name }))}
            className="min-w-56"
          />
          <SelectField
            name="role"
            label={t("development.matrix.role")}
            emptyOption={t("development.matrix.anyRole")}
            defaultValue={roleKey ?? ""}
            options={roles.map((r) => ({ value: r.key, label: r.name }))}
            className="min-w-56"
          />
          <Checkbox
            name="attention"
            value="yes"
            label={t("development.matrix.attention")}
            defaultChecked={attention}
          />
          <Button type="submit" variant="secondary">
            {t("development.matrix.apply")}
          </Button>
        </form>
      </Card>
      <p className="m-0 text-body-dense" aria-live="polite">
        {t("development.matrix.summary", {
          members: members.length,
          missing: counts.missing,
          expired: counts.expired,
          dueSoon: counts.due_soon,
        })}
      </p>
      {truncated ? (
        <p className="m-0 text-body-dense font-semibold">{t("development.matrix.truncated")}</p>
      ) : null}
      {rows.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={<GraduationCap size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("development.matrix.empty")}
            description={t("development.matrix.emptyHint")}
          />
        </Card>
      ) : (
        <TrainingMatrixGrid
          caption={t("development.matrix.caption")}
          columns={columns}
          rows={rows}
        />
      )}
    </div>
  );
}

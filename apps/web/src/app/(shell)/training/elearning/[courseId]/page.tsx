import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AttemptChip } from "@/components/elearning/AttemptChip";
import { ElearningPlayer } from "@/components/elearning/ElearningPlayer";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { attemptChip, ELEARNING_PAGE, SELF_READ } from "@/lib/elearning";
import { t } from "@/lib/i18n";

type Params = Promise<{ courseId: string }>;

export const metadata: Metadata = { title: t("elearning.player.title") };

/**
 * One course, taken in the player (WORK-006; ADR-0093). The package runs on the content origin in
 * a sandboxed frame; a completion or pass becomes a training record.
 */
export default async function CoursePage({ params }: { readonly params: Params }) {
  const { courseId } = await params;
  if (!isUuid(courseId)) notFound();
  const { me } = await getShellContext();
  if (!me.permissions.includes(SELF_READ)) return <SafetyForbidden title={t("elearning.title")} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/elearning/courses");
  if (!listed.data) failWith(listed.error, listed.response, `${ELEARNING_PAGE}/${courseId}`);
  const course = listed.data.items.find((c) => c.id === courseId && c.status === "active");
  if (!course) notFound();
  const mine = course.myAttempt;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={t("elearning.title")}
        title={course.title}
        description={t("elearning.player.description")}
      />
      <p className="m-0">
        <Link href={ELEARNING_PAGE} className="inline-flex min-h-target items-center underline">
          {t("elearning.back")}
        </Link>
      </p>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <AttemptChip chip={attemptChip(mine?.status ?? null, t)} />
      </p>
      <Card as="section" title={t("elearning.player.cardTitle")} headingLevel={2}>
        <ElearningPlayer
          courseId={course.id}
          title={course.title}
          resume={mine?.status === "in_progress"}
        />
      </Card>
    </div>
  );
}

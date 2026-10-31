import { TRAINING_TOPICS } from "@harbour/domain";
import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { GraduationCap } from "lucide-react";
import type { Metadata } from "next";
import { AttemptChip } from "@/components/elearning/AttemptChip";
import { AddCourseForm, RetireCourse } from "@/components/elearning/CourseForms";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { attemptChip, ELEARNING_PAGE, elearningManaged, elearningShown } from "@/lib/elearning";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("elearning.title") };

/**
 * E-learning courses (WORK-006; ADR-0093): each course with the reader's own latest attempt as an
 * icon and a word, opened in the player; training leads add courses from a package and retire
 * them. The API checks every permission again.
 */
export default async function ElearningPage() {
  const { me } = await getShellContext();
  const title = t("elearning.title");
  if (!elearningShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const listed = await api.GET("/v1/workforce/elearning/courses");
  if (!listed.data) failWith(listed.error, listed.response, ELEARNING_PAGE);
  const lead = elearningManaged(me.permissions);
  const courses = listed.data.items;

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("elearning.description")} />
      <Card as="section" title={t("elearning.list.title")} headingLevel={2}>
        {courses.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<GraduationCap size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("elearning.list.empty")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {courses.map((course) => (
              <li key={course.id} className="flex flex-col gap-2 border-b border-border pb-3">
                <h3 className="m-0 text-body font-semibold">
                  {course.status === "active" ? (
                    // A full page load, not a client navigation: the player's own Content
                    // Security Policy (which frames the content origin) must be the document's.
                    <a
                      href={`${ELEARNING_PAGE}/${course.id}`}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {course.title}
                    </a>
                  ) : (
                    course.title
                  )}
                </h3>
                <p className="m-0 text-body-dense">
                  {t("elearning.list.line", {
                    topic: course.topic,
                    standard: course.standard,
                    status: course.status,
                  })}
                </p>
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <AttemptChip chip={attemptChip(course.myAttempt?.status ?? null, t)} />
                  {course.myAttempt?.score != null ? (
                    <span className="text-body-dense">
                      {t("elearning.list.score", {
                        score: Math.round(course.myAttempt.score * 100),
                      })}
                    </span>
                  ) : null}
                </p>
                {lead && course.status === "active" ? (
                  <RetireCourse courseId={course.id} title={course.title} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {lead ? (
        <Card as="section" title={t("elearning.upload.cardTitle")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0">{t("elearning.upload.about")}</p>
            <AddCourseForm topics={TRAINING_TOPICS} />
          </div>
        </Card>
      ) : null}
    </div>
  );
}

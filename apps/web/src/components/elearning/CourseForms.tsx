"use client";

import { Button, SelectField, TextField } from "@harbour/ui";
import { Archive, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { retireCourse } from "@/app/actions/elearning";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import {
  ELEARNING_UPLOAD_PATH,
  PACKAGE_MAX_BYTES,
  TIER_HEADER,
  TITLE_HEADER,
  TOPIC_HEADER,
} from "@/lib/elearning";
import { t } from "@/lib/i18n";
import { type ActionResult, errorFor, fieldErrors } from "@/lib/outcome";

const FIELDS = ["title", "topic", "tier", "file"] as const;

/**
 * Add a course from a SCORM or xAPI zip (training leads). Sent to the upload route, which streams
 * it to the API; the API checks every entry of the archive and scans it before anything is kept.
 */
export function AddCourseForm({ topics }: { readonly topics: readonly string[] }) {
  const router = useRouter();
  const ids = useFieldIds(FIELDS);
  const [topic, setTopic] = useState("");
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const file = data.get("file");
    const tier = String(data.get("tier") ?? "");
    const problems: Record<string, string> = {};
    if (title.length < 2 || title.length > 160)
      problems.title = t("elearning.upload.titleRequired");
    if (!topics.includes(topic)) problems.topic = t("elearning.upload.topicRequired");
    if (topic === "oliver_mcgowan" && tier !== "1" && tier !== "2")
      problems.tier = t("elearning.upload.tierRequired");
    if (!(file instanceof File) || file.size === 0)
      problems.file = t("elearning.upload.fileRequired");
    else if (file.size > PACKAGE_MAX_BYTES) problems.file = t("elearning.upload.tooLarge");
    if (Object.keys(problems).length > 0) {
      setResult(fieldErrors(problems));
      return;
    }
    startTransition(async () => {
      const response = await fetch(ELEARNING_UPLOAD_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          [TITLE_HEADER]: encodeURIComponent(title),
          [TOPIC_HEADER]: topic,
          ...(topic === "oliver_mcgowan" ? { [TIER_HEADER]: tier } : {}),
        },
        body: file as File,
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as ActionResult<unknown> | null;
      if (!response?.ok || !body?.ok) {
        setResult(
          body && !body.ok
            ? { ...body, fields: { file: body.message } }
            : { ok: false, code: "unavailable", message: t("care.errors.unavailable") },
        );
        return;
      }
      setResult({ ok: true, data: null });
      form.reset();
      setTopic("");
      router.refresh();
    });
  };

  return (
    <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        id={ids.title}
        name="title"
        label={t("elearning.upload.title")}
        autoComplete="off"
        error={errorFor(result, "title")}
      />
      <SelectField
        id={ids.topic}
        name="topic"
        label={t("elearning.upload.topic")}
        hint={t("elearning.upload.topicHint")}
        emptyOption={t("elearning.choose")}
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
        options={topics.map((value) => ({ value, label: t("elearning.topic", { topic: value }) }))}
        error={errorFor(result, "topic")}
      />
      {topic === "oliver_mcgowan" ? (
        <SelectField
          id={ids.tier}
          name="tier"
          label={t("elearning.upload.tier")}
          emptyOption={t("elearning.choose")}
          options={[
            { value: "1", label: t("elearning.upload.tierName", { tier: 1 }) },
            { value: "2", label: t("elearning.upload.tierName", { tier: 2 }) },
          ]}
          error={errorFor(result, "tier")}
        />
      ) : null}
      <TextField
        id={ids.file}
        name="file"
        type="file"
        accept=".zip,application/zip"
        label={t("elearning.upload.file")}
        hint={t("elearning.upload.fileHint")}
        error={errorFor(result, "file")}
      />
      <div>
        <Button
          type="submit"
          disabled={pending}
          icon={<Upload size={18} strokeWidth={1.5} aria-hidden="true" />}
        >
          {pending ? t("elearning.upload.sending") : t("elearning.upload.submit")}
        </Button>
      </div>
      <FormFeedback result={result} success={t("elearning.upload.done")} fieldIds={ids} />
    </form>
  );
}

/** Retire a course: staff are no longer offered it (attempts and training records are kept). */
export function RetireCourse({
  courseId,
  title,
}: {
  readonly courseId: string;
  readonly title: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const outcome = await retireCourse(courseId);
          setResult(outcome);
          if (outcome.ok) router.refresh();
        });
      }}
    >
      <Button
        type="submit"
        variant="secondary"
        disabled={pending}
        icon={<Archive size={18} strokeWidth={1.5} aria-hidden="true" />}
      >
        {t("elearning.retire", { title })}
      </Button>
      {result && !result.ok ? <FormFeedback result={result} success="" /> : null}
    </form>
  );
}

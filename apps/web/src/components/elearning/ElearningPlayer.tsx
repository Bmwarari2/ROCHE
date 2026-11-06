"use client";

import { ELEARNING_PROTOCOL } from "@harbour/contracts";
import { Button } from "@harbour/ui";
import { Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { commitAttempt, type Launched, startAttempt } from "@/app/actions/elearning";
import { FormFeedback } from "@/components/care/FormFeedback";
import { readRuntimeMessage, startMessage } from "@/lib/elearning";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";

/**
 * The course player (ADR-0093). Starts or resumes the member's attempt, then frames Harbour's
 * runtime page on the content origin, sandboxed. Every message from it is checked (origin, the
 * frame's own window, the protocol's shape, this attempt) before anything is saved; the runtime
 * is told where to start only after it says it is ready.
 */
export function ElearningPlayer({
  courseId,
  title,
  resume,
}: {
  readonly courseId: string;
  readonly title: string;
  readonly resume: boolean;
}) {
  const router = useRouter();
  const frame = useRef<HTMLIFrameElement>(null);
  const [launch, setLaunch] = useState<Launched | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!launch) return;
    const target = launch.contentOrigin;
    const onMessage = (event: MessageEvent) => {
      const message = readRuntimeMessage(event, {
        origin: target,
        frame: frame.current?.contentWindow ?? null,
        attemptId: launch.attemptId,
      });
      if (!message) return;
      const reply = (ok: boolean) =>
        frame.current?.contentWindow?.postMessage(
          { protocol: ELEARNING_PROTOCOL, type: "committed", attemptId: launch.attemptId, ok },
          target,
        );
      if (message.type === "ready") {
        frame.current?.contentWindow?.postMessage(
          startMessage({ attemptId: launch.attemptId, ...launch.start }),
          target,
        );
        return;
      }
      void commitAttempt(launch.attemptId, { cmi: message.cmi, finished: message.finished }).then(
        (saved) => {
          reply(saved.ok);
          if (!saved.ok) {
            setResult(saved);
            return;
          }
          if (saved.data.status !== "in_progress" || message.finished) {
            setStatus(saved.data.status);
            router.refresh();
          }
        },
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [launch, router]);

  const start = () =>
    startTransition(async () => {
      const launched = await startAttempt(courseId);
      if (!launched.ok) {
        setResult(launched);
        return;
      }
      setResult(null);
      setLaunch(launched.data);
    });

  return (
    <div className="flex flex-col gap-4">
      {launch ? (
        <iframe
          ref={frame}
          src={launch.url}
          title={t("elearning.player.frameTitle", { title })}
          // Another site entirely (the content origin): its own origin is needed for the package to
          // find the SCORM API in Harbour's runtime page, and cannot reach the app's.
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerPolicy="no-referrer"
          className="h-[70vh] min-h-[480px] w-full rounded-md border border-border bg-bg"
        />
      ) : (
        <div>
          <Button
            type="button"
            onClick={start}
            disabled={pending}
            icon={<Play size={18} strokeWidth={1.5} aria-hidden="true" />}
          >
            {pending
              ? t("elearning.player.opening")
              : resume
                ? t("elearning.player.resume")
                : t("elearning.player.start")}
          </Button>
        </div>
      )}
      <div role="status" className="m-0">
        {status ? t("elearning.player.saved", { status }) : null}
      </div>
      {result && !result.ok ? <FormFeedback result={result} success="" /> : null}
    </div>
  );
}

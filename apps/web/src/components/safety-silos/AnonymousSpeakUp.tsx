"use client";

import type { AnonymousSpeakUpRaised, SpeakUpThread } from "@harbour/contracts";
import { Button, Card, Checkbox, TextArea, TextField } from "@harbour/ui";
import { KeyRound, Megaphone, Send } from "lucide-react";
import { type FormEvent, useState, useTransition } from "react";
import {
  raiseAnonymousConcern,
  readAnonymousThread,
  replyAnonymously,
} from "@/app/actions/safety-silos";
import { FormFeedback } from "@/components/care/FormFeedback";
import { useFieldIds } from "@/components/care/form-state";
import { formatDate, formatDateTime } from "@/lib/format";
import { characterCount, t } from "@/lib/i18n";
import { type ActionResult, errorFor } from "@/lib/outcome";
import {
  readAnonymousSpeakUp,
  readMessage,
  readReplyToken,
  SPEAK_UP_MESSAGE_MAX,
} from "@/lib/speak-up";
import { ConcernFields } from "./SpeakUpForms";

const icon = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

const refusal = (errors: Readonly<Record<string, string>>): ActionResult<never> => ({
  ok: false,
  code: "invalid",
  message: Object.values(errors)[0] ?? "",
  fields: errors,
});

/**
 * The public speak-up page's forms (ADR-0089). Nothing about the person is kept: no cookie, no
 * browser storage, the reply token never in an address. The token is shown once, here, after the
 * concern is sent; to read replies the person types it back in.
 */
export function AnonymousSpeakUp({ tenantId }: { readonly tenantId: string }) {
  const [raised, setRaised] = useState<AnonymousSpeakUpRaised | null>(null);
  return (
    <div className="flex flex-col gap-6">
      {raised ? <Raised raised={raised} /> : <RaiseForm tenantId={tenantId} onRaised={setRaised} />}
      <FollowUp tenantId={tenantId} />
    </div>
  );
}

function RaiseForm({
  tenantId,
  onRaised,
}: {
  readonly tenantId: string;
  readonly onRaised: (raised: AnonymousSpeakUpRaised) => void;
}) {
  const ids = useFieldIds(["category", "summary", "wantsReplies"]);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readAnonymousSpeakUp(new FormData(event.currentTarget), t);
    if (!read.ok) {
      setResult(refusal(read.errors));
      return;
    }
    startTransition(async () => {
      const outcome = await raiseAnonymousConcern(tenantId, read.body);
      setResult(outcome);
      if (outcome.ok) onRaised(outcome.data);
    });
  };
  return (
    <Card as="section" headingLevel={2} title={t("speakUp.anonymous.formTitle")}>
      <form method="post" className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <ConcernFields
          ids={ids}
          errors={{ category: errorFor(result, "category"), summary: errorFor(result, "summary") }}
        />
        <Checkbox
          id={ids.wantsReplies}
          name="wantsReplies"
          value="yes"
          label={t("speakUp.anonymous.wantsReplies")}
          hint={t("speakUp.anonymous.wantsRepliesHint")}
        />
        <div>
          <Button type="submit" icon={<Megaphone {...icon} />} disabled={pending}>
            {pending ? t("common.saving") : t("speakUp.anonymous.submit")}
          </Button>
        </div>
        <FormFeedback result={result} success="" fieldIds={ids} />
      </form>
    </Card>
  );
}

function Raised({ raised }: { readonly raised: AnonymousSpeakUpRaised }) {
  const ids = useFieldIds(["token"]);
  return (
    <Card as="section" headingLevel={2} title={t("speakUp.anonymous.raisedTitle")}>
      <div className="flex flex-col gap-3" role="status">
        <p className="m-0">
          {t("speakUp.anonymous.raisedBody", { date: formatDate(raised.receivedOn) ?? "" })}
        </p>
        {raised.replyToken ? (
          <>
            <p className="m-0 font-semibold">{t("speakUp.anonymous.keepToken")}</p>
            <TextField
              id={ids.token}
              label={t("speakUp.anonymous.tokenLabel")}
              hint={t("speakUp.anonymous.tokenHint", {
                date: formatDate(raised.replyTokenExpiresOn) ?? "",
              })}
              value={raised.replyToken}
              readOnly
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </>
        ) : (
          <p className="m-0">{t("speakUp.anonymous.noReplies")}</p>
        )}
      </div>
    </Card>
  );
}

function FollowUp({ tenantId }: { readonly tenantId: string }) {
  const ids = useFieldIds(["replyToken", "body"]);
  const [token, setToken] = useState("");
  const [thread, setThread] = useState<SpeakUpThread | null>(null);
  const [result, setResult] = useState<ActionResult<unknown> | null>(null);
  const [pending, startTransition] = useTransition();

  const open = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const read = readReplyToken(new FormData(event.currentTarget), t);
    if (!read.ok) {
      setResult(refusal(read.errors));
      return;
    }
    startTransition(async () => {
      const outcome = await readAnonymousThread(tenantId, read.body.replyToken);
      setResult(outcome.ok ? null : outcome);
      if (outcome.ok) {
        setToken(read.body.replyToken);
        setThread(outcome.data);
      }
    });
  };
  const reply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const read = readMessage(new FormData(form), t);
    if (!read.ok) {
      setResult(refusal(read.errors));
      return;
    }
    startTransition(async () => {
      const outcome = await replyAnonymously(tenantId, token, read.body.body);
      setResult(outcome);
      if (outcome.ok) {
        setThread(outcome.data);
        form.reset();
      }
    });
  };

  return (
    <Card as="section" headingLevel={2} title={t("speakUp.anonymous.followTitle")}>
      {thread ? (
        <div className="flex flex-col gap-4">
          <p className="m-0">{t("speakUp.state", { state: thread.state })}</p>
          {thread.outcome ? (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-body font-semibold">{t("speakUp.thread.outcome")}</h3>
              <p className="m-0 whitespace-pre-wrap">{thread.outcome}</p>
            </div>
          ) : null}
          <ThreadMessages messages={thread.messages} />
          {thread.state !== "closed" ? (
            <form method="post" className="flex flex-col gap-3" onSubmit={reply} noValidate>
              <TextArea
                id={ids.body}
                name="body"
                label={t("speakUp.message.reply")}
                rows={3}
                maxLength={SPEAK_UP_MESSAGE_MAX}
                formatCount={(remaining) => characterCount(remaining)}
                error={errorFor(result, "body")}
              />
              <div>
                <Button
                  type="submit"
                  variant="secondary"
                  icon={<Send {...icon} />}
                  disabled={pending}
                >
                  {pending ? t("common.saving") : t("speakUp.message.send")}
                </Button>
              </div>
            </form>
          ) : null}
          <FormFeedback result={result} success={t("speakUp.message.done")} fieldIds={ids} />
        </div>
      ) : (
        <form method="post" className="flex flex-col gap-3" onSubmit={open} noValidate>
          <p className="m-0">{t("speakUp.anonymous.followBody")}</p>
          <TextField
            id={ids.replyToken}
            name="replyToken"
            label={t("speakUp.anonymous.tokenLabel")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            error={errorFor(result, "replyToken")}
          />
          <div>
            <Button
              type="submit"
              variant="secondary"
              icon={<KeyRound {...icon} />}
              disabled={pending}
            >
              {pending ? t("common.saving") : t("speakUp.anonymous.open")}
            </Button>
          </div>
          <FormFeedback result={result} success="" fieldIds={ids} />
        </form>
      )}
    </Card>
  );
}

/** The messages on a concern, oldest first, each saying who it is from in words. */
export function ThreadMessages({ messages }: { readonly messages: SpeakUpThread["messages"] }) {
  if (messages.length === 0) return <p className="m-0">{t("speakUp.thread.noMessages")}</p>;
  return (
    <ol className="m-0 flex list-none flex-col gap-3 p-0">
      {messages.map((m) => (
        <li key={m.id} className="flex flex-col gap-1 border-l-2 border-border pl-3">
          <p className="m-0 text-body-dense font-semibold">
            {m.fromReporter
              ? t("speakUp.thread.fromReporter")
              : m.author
                ? m.author.displayName
                : t("speakUp.thread.fromCase")}
            {" · "}
            {formatDateTime(m.createdAt)}
          </p>
          <p className="m-0 whitespace-pre-wrap">{m.body}</p>
        </li>
      ))}
    </ol>
  );
}

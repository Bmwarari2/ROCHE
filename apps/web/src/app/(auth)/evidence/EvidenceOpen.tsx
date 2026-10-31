"use client";

import { Button, TextField } from "@harbour/ui";
import { CircleAlert, CircleCheck, Clock, Download, Lock, Mail } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { FormFeedback } from "@/components/care/FormFeedback";
import {
  BUNDLE_FILE_NAME,
  type EvidenceLinkResult,
  evidenceTokenFromFragment,
  isFinal,
  type LinkEnded,
  readEvidenceCode,
} from "@/lib/evidence-link";
import { t } from "@/lib/i18n";
import type { ActionResult } from "@/lib/outcome";

type View =
  | { readonly kind: "loading" }
  /** No token: a link copied without its end, or the page opened again after the code. */
  | { readonly kind: "no_token" }
  | { readonly kind: "ready" }
  | { readonly kind: "code"; readonly sent: boolean }
  | { readonly kind: "verified"; readonly downloaded: boolean }
  | { readonly kind: "ended"; readonly reason: LinkEnded }
  | { readonly kind: "throttled"; readonly minutes: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" };

/** POSTs to this page's route handlers (same origin, JSON body); never the token in a URL. */
async function call(path: "code" | "verify", body: object): Promise<EvidenceLinkResult> {
  try {
    const response = await fetch(`/api/evidence/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    return response.ok ? ((await response.json()) as EvidenceLinkResult) : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * Downloads the pack with this link's session cookie: the file goes to the browser's downloads as
 * a temporary in-memory link, released at once. A refusal comes back as JSON, said in words.
 */
async function download(): Promise<EvidenceLinkResult | "done"> {
  try {
    const response = await fetch("/api/evidence/bundle", { cache: "no-store" });
    if (response.headers.get("content-type")?.startsWith("application/pdf")) {
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = BUNDLE_FILE_NAME;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return "done";
    }
    return (await response.json()) as EvidenceLinkResult;
  } catch {
    return { kind: "unavailable" };
  }
}

/** The heading each view starts with: focus moves to it when the view changes. */
function ViewHeading({ children }: { readonly children: ReactNode }) {
  return (
    <h2 data-view-heading="" tabIndex={-1} className="m-0 text-body font-semibold">
      {children}
    </h2>
  );
}

/** A message in a box with an icon and a heading: never colour alone. */
function Message({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-card border border-border bg-card p-4">
      <span aria-hidden="true" className="mt-0.5 shrink-0">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-3">
        <ViewHeading>{title}</ViewHeading>
        {children}
      </div>
    </div>
  );
}

const icon = { size: 20, strokeWidth: 1.5 } as const;
const ENDED_ICON: Record<LinkEnded, ReactNode> = {
  revoked: <CircleAlert {...icon} />,
  expired: <Clock {...icon} />,
  locked: <Lock {...icon} />,
  not_released: <CircleAlert {...icon} />,
  wrong_recipient: <Lock {...icon} />,
};

/**
 * Opening an evidence pack from its link (QUAL-003; HZ-050; ADR-0050). The token is read from the
 * fragment and taken out of the address bar at once; it is kept only in this page's memory and
 * sent only in JSON bodies. The inspector asks for a code, which goes by email to the address the
 * provider used (never with the link), enters it, and downloads the watermarked pack with the
 * session the API sets for this link alone. Withdrawn, expired and locked links say so and what to
 * do; a wrong code or too many requests is said at the code field. Focus moves to each new view's
 * heading.
 */
export function EvidenceOpen() {
  const token = useRef<string | null>(null);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [codeResult, setCodeResult] = useState<ActionResult<unknown> | null>(null);
  const [said, setSaid] = useState("");
  const container = useRef<HTMLDivElement>(null);

  const started = useRef(false);
  useEffect(() => {
    // Once only: the fragment is gone after the first read (and React may run this twice).
    if (started.current) return;
    started.current = true;
    const fromLink = evidenceTokenFromFragment(window.location.hash);
    // Out of the address bar, history and any screenshot at once.
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    token.current = fromLink;
    setView(fromLink ? { kind: "ready" } : { kind: "no_token" });
  }, []);

  useEffect(() => {
    if (view.kind === "loading") return;
    container.current?.querySelector<HTMLElement>("[data-view-heading]")?.focus();
  }, [view.kind]);

  /** A result that ends or blocks the flow becomes its own view; others stay at the code. */
  const show = useCallback((result: EvidenceLinkResult): boolean => {
    if (isFinal(result) || result.kind === "unavailable") {
      if (result.kind === "ended") setView({ kind: "ended", reason: result.reason });
      else if (result.kind === "not_found") setView({ kind: "not_found" });
      else setView({ kind: "unavailable" });
      if (isFinal(result)) token.current = null;
      return true;
    }
    return false;
  }, []);

  const askForCode = async () => {
    if (!token.current) return;
    setBusy(true);
    const result = await call("code", { token: token.current });
    setBusy(false);
    if (show(result)) return;
    if (result.kind === "throttled") {
      setView({ kind: "code", sent: false });
      setCodeResult(fieldError(t("evidenceLink.throttled", { minutes: result.minutes })));
      return;
    }
    setCodeResult(null);
    setSaid(t("evidenceLink.codeSent", { sent: String(result.kind === "sent") }));
    setView({ kind: "code", sent: result.kind === "sent" });
  };

  const openPack = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("code");
    const code = typeof value === "string" ? readEvidenceCode(value) : null;
    if (!code) return setCodeResult(fieldError(t("evidenceLink.codeError", { why: "format" })));
    if (!token.current) return;
    setBusy(true);
    const result = await call("verify", { token: token.current, code });
    setBusy(false);
    if (show(result)) return;
    if (result.kind === "verified") {
      // The session now opens the pack; the token is not needed again.
      token.current = null;
      setCodeResult(null);
      setView({ kind: "verified", downloaded: false });
      return;
    }
    setCodeResult(
      fieldError(
        result.kind === "throttled"
          ? t("evidenceLink.throttled", { minutes: result.minutes })
          : t("evidenceLink.codeError", { why: result.kind === "wrong_code" ? "wrong" : "format" }),
      ),
    );
  };

  const getPack = async () => {
    setBusy(true);
    const result = await download();
    setBusy(false);
    if (result === "done") {
      setSaid(t("evidenceLink.downloaded"));
      setView({ kind: "verified", downloaded: true });
      return;
    }
    if (result.kind === "code_required") return setView({ kind: "no_token" });
    if (!show(result)) setView({ kind: "unavailable" });
  };

  return (
    <div ref={container} className="flex flex-col gap-4">
      <p role="status" className="m-0 text-body-dense">
        {busy ? t("evidenceLink.working") : said}
      </p>
      {view.kind === "loading" ? null : view.kind === "no_token" ? (
        <Message icon={<CircleAlert {...icon} />} title={t("evidenceLink.noToken.title")}>
          <p className="m-0">{t("evidenceLink.noToken.body")}</p>
          <div>
            <Button type="button" variant="secondary" disabled={busy} onClick={getPack}>
              <Download size={16} strokeWidth={1.5} aria-hidden="true" />
              {t("evidenceLink.download")}
            </Button>
          </div>
        </Message>
      ) : view.kind === "ready" ? (
        <Message icon={<Mail {...icon} />} title={t("evidenceLink.ready.title")}>
          <p className="m-0">{t("evidenceLink.ready.body")}</p>
          <div>
            <Button type="button" disabled={busy} onClick={askForCode}>
              {t("evidenceLink.sendCode")}
            </Button>
          </div>
        </Message>
      ) : view.kind === "code" ? (
        <Message icon={<Mail {...icon} />} title={t("evidenceLink.code.title")}>
          <p className="m-0">{t("evidenceLink.code.body", { sent: String(view.sent) })}</p>
          <form className="flex flex-col gap-4" onSubmit={openPack} noValidate>
            <TextField
              id="evidence-code"
              name="code"
              label={t("evidenceLink.code.label")}
              hint={t("evidenceLink.code.hint")}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              spellCheck={false}
              {...(codeResult && !codeResult.ok ? { error: codeResult.message } : {})}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {t("evidenceLink.open")}
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={askForCode}>
                {t("evidenceLink.newCode")}
              </Button>
            </div>
          </form>
          <FormFeedback result={codeResult} success="" fieldIds={{ code: "evidence-code" }} />
        </Message>
      ) : view.kind === "verified" ? (
        <Message icon={<CircleCheck {...icon} />} title={t("evidenceLink.verified.title")}>
          <p className="m-0">{t("evidenceLink.verified.body")}</p>
          <div>
            <Button type="button" disabled={busy} onClick={getPack}>
              <Download size={16} strokeWidth={1.5} aria-hidden="true" />
              {t("evidenceLink.download")}
            </Button>
          </div>
        </Message>
      ) : view.kind === "ended" ? (
        <Message
          icon={ENDED_ICON[view.reason]}
          title={t("evidenceLink.ended.title", { reason: view.reason })}
        >
          <p className="m-0">{t("evidenceLink.ended.body", { reason: view.reason })}</p>
        </Message>
      ) : view.kind === "throttled" ? (
        <Message icon={<Clock {...icon} />} title={t("evidenceLink.throttledTitle")}>
          <p className="m-0">{t("evidenceLink.throttled", { minutes: view.minutes })}</p>
        </Message>
      ) : view.kind === "not_found" ? (
        <Message icon={<CircleAlert {...icon} />} title={t("evidenceLink.notFound.title")}>
          <p className="m-0">{t("evidenceLink.notFound.body")}</p>
        </Message>
      ) : (
        <Message icon={<CircleAlert {...icon} />} title={t("evidenceLink.unavailable.title")}>
          <p className="m-0">{t("evidenceLink.unavailable.body")}</p>
        </Message>
      )}
    </div>
  );
}

/** An error at the code field, which the summary links to (WCAG 3.3.1). */
function fieldError(message: string): ActionResult<never> {
  return { ok: false, code: "invalid", message, fields: { code: message } };
}

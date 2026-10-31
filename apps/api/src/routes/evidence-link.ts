import {
  EvidenceLinkCodeRequest,
  EvidenceLinkCodeSent,
  EvidenceLinkVerify,
  ProblemDetails,
} from "@harbour/contracts";
import {
  evidencePack,
  evidencePackLink,
  evidencePackLinkCode,
  type Transaction,
} from "@harbour/db";
import {
  EVIDENCE_LINK_MAX_CODE_ATTEMPTS,
  EVIDENCE_PACK_LINK_MESSAGES,
  type EvidencePackLinkRefusal,
  evidencePackLinkAccess,
  isWellFormedEvidenceCode,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { writeAudit } from "../http/audit";
import type { AppEnv } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import { throttleAddress } from "../http/throttle";
import {
  auditLink,
  codeMatches,
  EVIDENCE_CODE_EMAIL_TITLE,
  EVIDENCE_SESSION_COOKIE,
  evidenceCodeEmailBody,
  evidenceCodeHash,
  type FoundLink,
  findLinkByToken,
  inLinkSession,
  linkView,
  MAX_LIVE_CODES_PER_LINK,
  newEvidenceCode,
  readLinkSession,
  signLinkSession,
} from "../services/evidence-link";
import {
  type BundleContent,
  bundleOf,
  currentItems,
  type StoredField,
} from "../services/evidence-pack";
import { renderEvidencePackPdf } from "../services/evidence-pack-pdf";
import { createRouter, jsonBody } from "./openapi";

/**
 * The public evidence pack link routes (quality.md section 15; ADR-0050; HZ-050), outside the
 * tenant API: no Harbour sign-in. The token arrives only in a request body and is looked up by its
 * SHA-256; after the code, the browser holds a signed HttpOnly, Secure, SameSite=Strict cookie for
 * that link alone, and opening the pack needs nothing else, so neither the token nor a code is ever
 * in a URL, a log or an audit row. Every request runs as the link session (migration 0058).
 * Throttled per client address and per link; every code sent, failed code, lock-out and open is
 * audited in the organisation's chain with ids only.
 */

const A = {
  codeSent: "quality.evidence_pack.code_sent",
  codeFailed: "quality.evidence_pack.code_failed",
  codeVerified: "quality.evidence_pack.code_verified",
  locked: "quality.evidence_pack.link_locked",
  opened: "quality.evidence_pack.opened",
} as const;

const problem = (description: string) => ({
  content: { "application/problem+json": { schema: ProblemDetails } },
  description,
});
const publicErrors = {
  404: problem("No such link"),
  410: problem("The link no longer opens: withdrawn, expired or locked"),
  422: problem("The request did not validate, or the code was wrong"),
  429: problem("Too many requests; wait as Retry-After says"),
} as const;

const ENDED: Readonly<Record<EvidencePackLinkRefusal, number>> = {
  not_released: 410,
  revoked: 410,
  expired: 410,
  locked: 410,
  code_required: 401,
  wrong_recipient: 403,
};

const refusalProblem = (reason: EvidencePackLinkRefusal) =>
  new HttpProblem(
    ENDED[reason] as 401 | 403 | 410,
    `link_${reason}`,
    EVIDENCE_PACK_LINK_MESSAGES[reason],
  );

/** The client address from the trusted-proxy hop (`throttleAddress`), or null. */
const addressOf = (c: Context<AppEnv>) =>
  throttleAddress(c.req.header("x-forwarded-for"), c.get("services").config.trustedProxies);

/**
 * Throttles per client address (the trusted-proxy hop; with none, one shared bucket rather than
 * none at all, #66 security review L3), then per link once it is known.
 */
function throttle(c: Context<AppEnv>, link: string | null): void {
  const { address, link: perLink } = c.get("services").evidenceLinkThrottles;
  const wait =
    link === null
      ? address.take(`address:${addressOf(c) ?? "unknown"}`)
      : perLink.take(`link:${link}`);
  if (wait === null) return;
  const limited = new HttpProblem(
    429,
    "rate_limited",
    "Too many attempts. Wait a moment and try again.",
  );
  limited.retryAfterSeconds = wait;
  throw limited;
}

/** The link the token names, or 404 with a platform audit event (no organisation is known). */
async function linkFor(c: Context<AppEnv>, token: string, action: string): Promise<FoundLink> {
  throttle(c, null);
  const services = c.get("services");
  const found = await findLinkByToken(services.appPool, token);
  if (!found) {
    await writeAudit(services.appPool, null, {
      action,
      outcome: "denied",
      reason: "unknown_token",
      ip: addressOf(c),
      requestId: c.get("requestId"),
    });
    throw problems.notFound();
  }
  throttle(c, found.linkId);
  return found;
}

type Outcome<T> = { readonly ok: T } | { readonly refused: HttpProblem };

/** The link's state before a code: anything but "code required" ends the request. */
async function openLink(
  tx: Transaction,
  found: FoundLink,
): Promise<
  | { readonly refused: HttpProblem; readonly reason: string }
  | { readonly link: NonNullable<Awaited<ReturnType<typeof linkView>>> }
> {
  const link = await linkView(tx, found.linkId);
  if (!link) return { refused: problems.notFound(), reason: "not_found" };
  const access = evidencePackLinkAccess(link, { at: new Date(), session: null });
  if (!access.allowed && access.reason !== "code_required") {
    return { refused: refusalProblem(access.reason), reason: access.reason };
  }
  return { link };
}

export const evidenceLinkRouter = createRouter()
  .openapi(
    createRoute({
      method: "post",
      path: "/p/evidence/code",
      tags: ["quality"],
      summary: "Send a one-time code to the link's recipient",
      description:
        "No sign-in. The token goes in the body. Sends a six-digit code to the address the link is bound to, never with the link; at most three codes open at once for a link; each lasts evidence_pack.code_valid_minutes (at most 10). Throttled per client address and per link. Audited.",
      request: {
        body: { content: { "application/json": { schema: EvidenceLinkCodeRequest } } },
      },
      responses: { 202: jsonBody(EvidenceLinkCodeSent, "Asked for"), ...publicErrors },
    }),
    async (c) => {
      const { token } = c.req.valid("json");
      const services = c.get("services");
      const found = await linkFor(c, token, A.codeSent);
      const meta = { ip: addressOf(c), requestId: c.get("requestId") };
      const code = newEvidenceCode();
      const outcome = await inLinkSession(
        services.db,
        found,
        async (tx): Promise<Outcome<{ id: string; to: string }>> => {
          const open = await openLink(tx, found);
          if ("refused" in open) {
            await auditLink(tx, found, A.codeSent, {
              ...meta,
              outcome: "denied",
              reason: open.reason,
            });
            return { refused: open.refused };
          }
          const live = await tx
            .select({ id: evidencePackLinkCode.id })
            .from(evidencePackLinkCode)
            .where(
              and(
                eq(evidencePackLinkCode.linkId, found.linkId),
                isNull(evidencePackLinkCode.usedAt),
                gt(evidencePackLinkCode.validUntil, sql`now()`),
              ),
            );
          if (live.length >= MAX_LIVE_CODES_PER_LINK) {
            await auditLink(tx, found, A.codeSent, {
              ...meta,
              outcome: "denied",
              reason: "too_many_codes",
            });
            const limited = new HttpProblem(
              429,
              "too_many_codes",
              "Codes have already been sent. Use the newest one, or wait ten minutes and ask again.",
            );
            limited.retryAfterSeconds = 600;
            return { refused: limited };
          }
          const [row] = await tx
            .insert(evidencePackLinkCode)
            .values({
              linkId: found.linkId,
              codeHash: evidenceCodeHash(services.config.EVIDENCE_LINK_SECRET, found.linkId, code),
              // Worked out again by the database from the rate table (at most 10 minutes).
              validUntil: sql`now() + interval '1 minute'`,
            })
            .returning({ id: evidencePackLinkCode.id });
          await auditLink(tx, found, A.codeSent, meta);
          return { ok: { id: row?.id as string, to: open.link.recipientEmail } };
        },
      );
      if ("refused" in outcome) throw outcome.refused;
      const sent = await inLinkSession(services.db, found, async (tx) => {
        const adapter = await services.adapterFor(found.tenantId, "email", tx);
        // A generic subject; the code and what to do with it in the body; no link, nothing about
        // the pack (H-225).
        return adapter.send({
          idempotencyKey: outcome.ok.id,
          title: EVIDENCE_CODE_EMAIL_TITLE,
          link: null,
          to: outcome.ok.to,
          body: evidenceCodeEmailBody(code),
        });
      });
      if (!sent.ok) {
        await inLinkSession(services.db, found, (tx) =>
          auditLink(tx, found, "quality.evidence_pack.code_email_failed", {
            ...meta,
            outcome: "error",
            reason: sent.retryable ? "retryable" : "not_retryable",
          }),
        );
      }
      return c.json({ sent: sent.ok }, 202);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/p/evidence/verify",
      tags: ["quality"],
      summary: "Check a one-time code and open a session for this link",
      description:
        "No sign-in. A code that is not six digits is refused before it is compared and not counted. A right code is marked used and sets an HttpOnly, Secure, SameSite=Strict cookie for this link alone (never past the link's expiry). A wrong code adds one to the link's failed attempts in the same transaction; at the limit the link locks for good. Audited.",
      request: { body: { content: { "application/json": { schema: EvidenceLinkVerify } } } },
      responses: { 204: { description: "Verified; the session cookie is set" }, ...publicErrors },
    }),
    async (c) => {
      const { token, code } = c.req.valid("json");
      if (!isWellFormedEvidenceCode(code)) {
        throw problems.invalid("Enter the six-digit code from the email.");
      }
      const services = c.get("services");
      const secret = services.config.EVIDENCE_LINK_SECRET;
      const found = await linkFor(c, token, A.codeFailed);
      const meta = { ip: addressOf(c), requestId: c.get("requestId") };
      const outcome = await inLinkSession(
        services.db,
        found,
        async (tx): Promise<Outcome<{ email: string; expiresAt: Date }>> => {
          // The link row is locked, so attempts on one link are counted one at a time.
          const open = await openLink(tx, found);
          if ("refused" in open) {
            await auditLink(tx, found, A.codeFailed, {
              ...meta,
              outcome: "denied",
              reason: open.reason,
            });
            return { refused: open.refused };
          }
          const live = await tx
            .select({ id: evidencePackLinkCode.id, codeHash: evidencePackLinkCode.codeHash })
            .from(evidencePackLinkCode)
            .where(
              and(
                eq(evidencePackLinkCode.linkId, found.linkId),
                isNull(evidencePackLinkCode.usedAt),
                gt(evidencePackLinkCode.validUntil, sql`clock_timestamp()`),
              ),
            );
          const matched = codeMatches(secret, found.linkId, code, live);
          if (matched) {
            await tx
              .update(evidencePackLinkCode)
              .set({ usedAt: sql`now()` })
              .where(eq(evidencePackLinkCode.id, matched));
            await auditLink(tx, found, A.codeVerified, meta);
            return { ok: { email: open.link.recipientEmail, expiresAt: open.link.expiresAt } };
          }
          const [counted] = await tx
            .update(evidencePackLink)
            .set({ failedCodeAttempts: sql`${evidencePackLink.failedCodeAttempts} + 1` })
            .where(eq(evidencePackLink.id, found.linkId))
            .returning({ attempts: evidencePackLink.failedCodeAttempts });
          const attempts = counted?.attempts ?? EVIDENCE_LINK_MAX_CODE_ATTEMPTS;
          await auditLink(tx, found, A.codeFailed, {
            ...meta,
            outcome: "denied",
            reason: "wrong_code",
            scope: { attempts },
          });
          if (attempts >= EVIDENCE_LINK_MAX_CODE_ATTEMPTS) {
            await auditLink(tx, found, A.locked, { ...meta, scope: { attempts } });
            return { refused: refusalProblem("locked") };
          }
          return {
            refused: new HttpProblem(
              422,
              "wrong_code",
              "That code is not right, or it has expired.",
              "Check the newest email, or ask for a new code.",
            ),
          };
        },
      );
      if ("refused" in outcome) throw outcome.refused;
      const expiresAt = Math.min(
        Date.now() + services.config.EVIDENCE_LINK_SESSION_MINUTES * 60_000,
        outcome.ok.expiresAt.getTime(),
      );
      setCookie(
        c,
        EVIDENCE_SESSION_COOKIE,
        signLinkSession(secret, { ...found, verifiedEmail: outcome.ok.email, expiresAt }),
        {
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
          path: "/",
          // A browser-session cookie (no Max-Age, #113 security review L3): it goes when the
          // browser closes, and its sealed expiry (never past the link's) is checked on every
          // request, so it never outlives the session it carries.
        },
      );
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/p/evidence/bundle",
      tags: ["quality"],
      summary: "Open the evidence pack (needs this link's session)",
      description:
        "No sign-in and no token: the session cookie set by /p/evidence/verify for this link. The link must still be open (released, not revoked, not expired, not locked) and the session's address the recipient's. Streams the watermarked PDF drawn from the bundle (never stored; no-store; attachment); refused once the bundle is deleted. Every open is audited.",
      responses: {
        200: {
          content: { "application/pdf": { schema: z.string().meta({ format: "binary" }) } },
          description: "The pack",
        },
        401: problem("No session for this link: enter the code first"),
        403: problem("The session is for someone else"),
        ...publicErrors,
      },
    }),
    async (c) => {
      const services = c.get("services");
      const session = readLinkSession(
        services.config.EVIDENCE_LINK_SECRET,
        getCookie(c, EVIDENCE_SESSION_COOKIE),
      );
      if (!session) throw refusalProblem("code_required");
      throttle(c, null);
      throttle(c, session.linkId);
      const meta = { ip: addressOf(c), requestId: c.get("requestId") };
      const outcome = await inLinkSession(
        services.db,
        session,
        async (tx): Promise<Outcome<Uint8Array>> => {
          const link = await linkView(tx, session.linkId);
          if (!link) return { refused: refusalProblem("code_required") };
          const access = evidencePackLinkAccess(link, { at: new Date(), session });
          if (!access.allowed) {
            await auditLink(tx, session, A.opened, {
              ...meta,
              outcome: "denied",
              reason: access.reason,
            });
            return { refused: refusalProblem(access.reason) };
          }
          const [pack] = await tx
            .select()
            .from(evidencePack)
            .where(eq(evidencePack.id, session.packId));
          const bundle = await bundleOf(tx, session.packId);
          if (!pack || bundle.content === null) {
            await auditLink(tx, session, A.opened, {
              ...meta,
              outcome: "denied",
              reason: "bundle_deleted",
            });
            return { refused: refusalProblem("expired") };
          }
          const items = (await currentItems(tx, session.packId)).filter(
            (i) => i.exclusionReason === null,
          );
          const bytes = renderEvidencePackPdf(
            pack,
            items.map((i) => ({ ...i, fields: i.fields as StoredField[] })),
            bundle.content as BundleContent,
          );
          await tx
            .update(evidencePackLink)
            .set({ lastOpenedAt: sql`now()` })
            .where(eq(evidencePackLink.id, session.linkId));
          await auditLink(tx, session, A.opened, { ...meta, scope: { items: items.length } });
          return { ok: bytes };
        },
      );
      if ("refused" in outcome) throw outcome.refused;
      return c.body(outcome.ok as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="evidence-pack-${session.packId}.pdf"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; sandbox",
      });
    },
  );

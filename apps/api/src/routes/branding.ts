import { Branding, DocumentItem, SaveBranding } from "@harbour/contracts";
import { document, type Transaction, tenant } from "@harbour/db";
import {
  checkAccent,
  checkBrandName,
  DOCUMENT_CATEGORIES,
  stripImageMetadata,
} from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { auditInTx, writeAudit } from "../http/audit";
import { type AppEnv, requirePermission, withTenant } from "../http/context";
import { HttpProblem, problems } from "../http/problem";
import {
  contentHeaders,
  destroyingOnFailure,
  imagePrintableOf,
  readDocumentContent,
  storeDocument,
  toDocumentItems,
} from "../services/documents";
import {
  conflictResponse,
  createRouter,
  errorResponses,
  jsonBody,
  notFoundResponse,
  security,
} from "./openapi";

/**
 * White-label branding (PLAT-002; platform.md, white-label branding): the organisation's display
 * name, accent colour and logo, read by every member (the shell shows them) and set by
 * platform.tenant.manage. An accent that would leave words or controls below WCAG 2.2 AA contrast
 * in either theme is refused with why and a passing colour of the same hue; Harbour never stores
 * or shows one. Branding holds no personal data; changes are audited with what changed.
 */

const MANAGE = "platform.tenant.manage" as const;
const LOGO_CATEGORY = "organisation_logo" as const;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const LOGO_MAX_BYTES = DOCUMENT_CATEGORIES[LOGO_CATEGORY].maxBytes;
type ImageType = (typeof IMAGE_TYPES)[number];

const binary = z.string().meta({ format: "binary" });
const imageContent = {
  "image/jpeg": { schema: binary },
  "image/png": { schema: binary },
  "image/webp": { schema: binary },
} as const;

/** Plain-English reasons, the same words the settings screen shows (en-GB.json, platform.branding). */
const ACCENT_REFUSAL = {
  not_a_colour: "Enter the colour as a six-digit hex code, for example #0074e8.",
  too_light:
    "This colour is too light: white words on it, such as on buttons, would be hard to read.",
  too_dark:
    "This colour is too dark: it would be hard to see against the dark theme's black background.",
} as const;

const NAME_REFUSAL = {
  too_long: "Keep the display name to 80 characters or fewer.",
  control_characters: "The display name has characters that cannot be shown. Type it again.",
} as const;

type TenantRow = typeof tenant.$inferSelect;

/** The logo shown in the shell: clean, of its own category, under the tenant's RLS. */
export async function logoOf(tx: Transaction, t: TenantRow): Promise<Branding["logo"]> {
  if (!t.logoDocumentId) return null;
  const [row] = await tx
    .select({ id: document.id, contentType: document.contentType })
    .from(document)
    .where(
      and(
        eq(document.id, t.logoDocumentId),
        eq(document.category, LOGO_CATEGORY),
        eq(document.status, "available"),
        isNull(document.deletedAt),
      ),
    );
  if (!row || !IMAGE_TYPES.includes(row.contentType as ImageType)) return null;
  return { documentId: row.id, contentType: row.contentType as ImageType };
}

async function brandingOf(tx: Transaction, t: TenantRow): Promise<Branding> {
  return {
    registeredName: t.name,
    displayName: t.brandName,
    // A stored colour that no longer passes (set before the check existed) is not offered.
    accent: t.brandAccent && checkAccent(t.brandAccent).ok ? t.brandAccent : null,
    logo: await logoOf(tx, t),
    version: t.version,
  };
}

async function lockedTenant(tx: Transaction, tenantId: string): Promise<TenantRow> {
  const [t] = await tx.select().from(tenant).where(eq(tenant.id, tenantId)).for("update");
  if (!t) throw problems.notFound();
  return t;
}

function stale(): HttpProblem {
  return new HttpProblem(
    409,
    "version_conflict",
    "The branding changed since you opened it.",
    "Reload the page and try again.",
  );
}

async function refuse(
  c: Context<AppEnv>,
  access: Awaited<ReturnType<typeof requirePermission>>,
  code: "brand_accent_contrast" | "invalid",
  reason: string,
  detail: string,
): Promise<never> {
  await writeAudit(c.get("services").appPool, access, {
    action: "platform.branding.updated",
    outcome: "denied",
    reason,
    requestId: c.get("requestId"),
  });
  throw new HttpProblem(422, code, "The branding cannot be saved.", detail);
}

export const brandingRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/branding",
      tags: ["platform"],
      summary: "The organisation's white-label name, accent and logo",
      description:
        "Any member: the shell shows them. Holds no personal data, so it is not audited as a view.",
      security,
      responses: { 200: jsonBody(Branding, "Branding"), ...errorResponses },
    }),
    async (c) => {
      const access = c.get("access");
      const body = await withTenant(c, async (tx) => {
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
        if (!t) throw problems.notFound();
        return brandingOf(tx, t);
      });
      return c.json(body, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/branding",
      tags: ["platform"],
      summary: "Set the display name and accent colour",
      description:
        "platform.tenant.manage. The display name is trimmed (blank uses the registered name; at most 80 characters). The accent must keep white words on it and itself at 4.5:1 on white and on black, and at 3:1 on every other surface of the light and dark themes (`checkAccent`); one that fails is refused with 422 brand_accent_contrast, saying why, and nothing is stored. Send the `version` read (409 when stale). Audited (platform.branding.updated, with the fields changed and the old and new accent), refusals too.",
      security,
      request: { body: { content: { "application/json": { schema: SaveBranding } } } },
      responses: {
        200: jsonBody(Branding, "Saved"),
        ...errorResponses,
        ...conflictResponse,
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const input = c.req.valid("json");
      const name = checkBrandName(input.displayName);
      if (!name.ok) {
        return refuse(c, access, "invalid", `name_${name.problem}`, NAME_REFUSAL[name.problem]);
      }
      let accent: string | null = null;
      if (input.accent !== null && input.accent.trim() !== "") {
        const verdict = checkAccent(input.accent);
        if (!verdict.ok) {
          const detail =
            verdict.problem === "not_a_colour"
              ? ACCENT_REFUSAL.not_a_colour
              : `${ACCENT_REFUSAL[verdict.problem]} Try ${verdict.suggestion}, the nearest colour that works.`;
          return refuse(c, access, "brand_accent_contrast", `accent_${verdict.problem}`, detail);
        }
        accent = verdict.accent;
      }
      const saved = await withTenant(c, async (tx) => {
        const before = await lockedTenant(tx, access.tenantId);
        if (before.version !== input.expectedVersion) throw stale();
        const [t] = await tx
          .update(tenant)
          .set({ brandName: name.name, brandAccent: accent })
          .where(and(eq(tenant.id, access.tenantId), eq(tenant.version, input.expectedVersion)))
          .returning();
        if (!t) throw stale();
        const changed = [
          ...(before.brandName !== t.brandName ? ["displayName"] : []),
          ...(before.brandAccent !== t.brandAccent ? ["accent"] : []),
        ];
        await auditInTx(tx, access, {
          action: "platform.branding.updated",
          resourceType: "tenant",
          resourceId: access.tenantId,
          // Organisation data, not personal data: the colours are kept, the name is not.
          scope: { changed, accentBefore: before.brandAccent, accentAfter: t.brandAccent },
          requestId: c.get("requestId"),
        });
        return brandingOf(tx, t);
      });
      return c.json(saved, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/branding/logo",
      tags: ["platform"],
      summary: "The organisation's logo (any member; the shell shows it)",
      description:
        "Not audited as a view: a logo is about no one and is shown on every page. 404 when there is none.",
      security,
      responses: {
        200: { content: imageContent, description: "The logo" },
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      const access = c.get("access");
      const { storage } = c.get("services");
      const { row, bytes } = await withTenant(c, async (tx) => {
        const [t] = await tx.select().from(tenant).where(eq(tenant.id, access.tenantId));
        const logo = t ? await logoOf(tx, t) : null;
        if (!logo) throw problems.notFound();
        return readDocumentContent(tx, storage, logo.documentId);
      });
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, contentHeaders(row));
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/v1/branding/logo",
      tags: ["platform"],
      summary: "Set the organisation's logo (the body is the image)",
      description:
        "platform.tenant.manage. PNG or JPEG (never SVG), at most 512 KB, stripped of EXIF, XMP, IPTC and text chunks, checked by its contents and scanned for malware like any document. Refusals are audited. The logo is shown once it is clean; a quarantined file is kept but never shown. The previous logo stays in the document store until its retention ends. Audited (platform.branding.logo).",
      security,
      request: { body: { content: imageContent, required: true } },
      responses: {
        201: jsonBody(DocumentItem, "Logo stored"),
        ...errorResponses,
        413: jsonBody(z.object({ code: z.string() }), "The file is too large"),
      },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const received = new Uint8Array(await c.req.arrayBuffer());
      const denied = (reason: string) =>
        writeAudit(c.get("services").appPool, access, {
          action: "platform.branding.logo",
          outcome: "denied",
          reason,
          requestId: c.get("requestId"),
        });
      // Size first, so nothing larger than a logo is ever decoded (security review, PLAT-002).
      if (received.length > LOGO_MAX_BYTES) {
        await denied("too_large");
        throw problems.invalid("The logo must be 512 KB or smaller.");
      }
      // The logo is shown to every member: EXIF, XMP, IPTC and text chunks are removed first.
      const bytes = stripImageMetadata(received);
      if (!bytes) {
        await denied("type_not_allowed");
        throw problems.invalid("The logo must be a PNG or JPEG image.");
      }
      // Decided before the transaction opens: decoding an image never holds a connection.
      const imagePrintable = imagePrintableOf(bytes);
      const { scanner } = c.get("services");
      const item = await destroyingOnFailure(c.get("services").storage, (storage) =>
        withTenant(c, async (tx) => {
          await lockedTenant(tx, access.tenantId);
          const row = await storeDocument(tx, { storage, scanner }, access.tenantId, {
            bytes,
            imagePrintable,
            declaredType: c.req.header("content-type") ?? null,
            category: LOGO_CATEGORY,
            title: "Organisation logo",
            subjectType: "tenant",
            subjectId: access.tenantId,
          });
          if (row.status === "available") {
            await tx
              .update(tenant)
              .set({ logoDocumentId: row.id })
              .where(eq(tenant.id, access.tenantId));
          }
          await auditInTx(tx, access, {
            action: "platform.branding.logo",
            resourceType: "tenant",
            resourceId: access.tenantId,
            after: { documentId: row.id, status: row.status, sha256: row.sha256 },
            requestId: c.get("requestId"),
          });
          const [view] = await toDocumentItems(tx, [row]);
          return view;
        }),
      ).catch(async (error: unknown) => {
        // A refusal (the type, the size or the malware scan) is audited too, then passed on.
        if (error instanceof HttpProblem && error.status === 422) await denied("refused");
        throw error;
      });
      return c.json(item as DocumentItem, 201);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/v1/branding/logo",
      tags: ["platform"],
      summary: "Stop showing the organisation's logo",
      description:
        "platform.tenant.manage. The shell shows the product name again; the file stays in the document store until its retention ends. Audited (platform.branding.logo, removed).",
      security,
      responses: { 200: jsonBody(Branding, "Removed"), ...errorResponses },
    }),
    async (c) => {
      const access = await requirePermission(c, MANAGE);
      const body = await withTenant(c, async (tx) => {
        const before = await lockedTenant(tx, access.tenantId);
        const [t] = await tx
          .update(tenant)
          .set({ logoDocumentId: null })
          .where(eq(tenant.id, access.tenantId))
          .returning();
        if (!t) throw problems.notFound();
        await auditInTx(tx, access, {
          action: "platform.branding.logo",
          resourceType: "tenant",
          resourceId: access.tenantId,
          before: { documentId: before.logoDocumentId },
          after: { documentId: null },
          requestId: c.get("requestId"),
        });
        return brandingOf(tx, t);
      });
      return c.json(body, 200);
    },
  );

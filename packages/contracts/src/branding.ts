import { z } from "zod";

/** White-label branding contracts (PLAT-002; platform.md, white-label branding). */

const uuid = z.uuid();

export const Branding = z
  .object({
    /** The organisation's registered trading name, shown when no display name is set. */
    registeredName: z.string(),
    /** The name members see in the shell, or null for the registered name. */
    displayName: z.string().nullable(),
    /** A colour that passed every contrast check (`#rrggbb`), or null for Harbour's own. */
    accent: z.string().nullable(),
    logo: z
      .object({
        documentId: uuid,
        contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      })
      .nullable(),
    /** The organisation record's version, sent back to save (409 when stale). */
    version: z.number().int(),
  })
  .meta({ id: "Branding" });
export type Branding = z.infer<typeof Branding>;

export const SaveBranding = z
  .object({
    /** Blank or null uses the registered name. At most 80 characters (`checkBrandName`). */
    displayName: z.string().max(400).nullable(),
    /** Six-digit hex; null uses Harbour's own. Refused with 422 accent_contrast when it fails. */
    accent: z.string().max(20).nullable(),
    expectedVersion: z.number().int(),
  })
  .meta({ id: "SaveBranding" });
export type SaveBranding = z.infer<typeof SaveBranding>;

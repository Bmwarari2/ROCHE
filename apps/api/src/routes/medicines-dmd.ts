import {
  DmdGtinMatch,
  DmdProductDetail,
  DmdReleaseHistory,
  DmdSearchResult,
} from "@harbour/contracts";
import { dmdSearchQuery, toGtin14, ukDateOf } from "@harbour/domain";
import { createRoute, z } from "@hono/zod-openapi";
import { requireAnyPermission, withTenant } from "../http/context";
import { HttpProblem } from "../http/problem";
import {
  dmdGtinMatches,
  dmdProductDetail,
  dmdReleaseHistory,
  dmdReleaseStatus,
  searchDmdProducts,
} from "../services/dmd";
import { createRouter, errorResponses, jsonBody, notFoundResponse, security } from "./openapi";

/**
 * dm+d reference data (integrations.md section 11; INTG-006, MEDS-001; ADR-0080; HZ-113): search,
 * a product with its units and forms, the packs a barcode names, and the release history. For
 * anyone who works with medicines. National reference data with no personal data: reads are not
 * care-record views and are not audited one by one (each load is in the release history). Every
 * response carries the release in use and whether it is out of date (rule 5).
 */

const READERS = [
  "medicines.record.manage",
  "medicines.emar.administer",
  "medicines.stock.manage",
] as const;

const DmdIdParam = z.object({ id: z.string().regex(/^[1-9]\d{5,17}$/) });

export const medicinesDmdRouter = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/dmd/products",
      tags: ["medicines"],
      summary: "Search dm+d products",
      description:
        "Any of medicines.record.manage, medicines.emar.administer or medicines.stock.manage. VMPs and AMPs in the release in use whose names start with each word typed (`par 500`), or the product with a dm+d code; invalid products, and products dm+d has given a new identifier, only with `includeInvalid` or by their code, and then marked; shortest names first, at most 25. Names only: ingredients are never searched. A mistyped code is refused (422), never matched to a near one.",
      security,
      request: {
        query: z.object({
          q: z.string().max(200),
          includeInvalid: z.enum(["true", "false"]).optional(),
        }),
      },
      responses: { 200: jsonBody(DmdSearchResult, "Matching products"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const { q, includeInvalid } = c.req.valid("query");
      const check = dmdSearchQuery(q);
      if (!check.ok) throw new HttpProblem(422, check.problem, check.message);
      const result = await withTenant(c, async (tx) => ({
        release: await dmdReleaseStatus(tx),
        ...(await searchDmdProducts(tx, check.query, includeInvalid === "true")),
      }));
      return c.json(
        {
          ...result,
          query: {
            kind: check.query.kind,
            terms: check.query.kind === "text" ? [...check.query.terms] : [check.query.id],
          },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/dmd/products/{id}",
      tags: ["medicines"],
      summary: "A dm+d product with its units, forms, routes and packs",
      description:
        "Any medicines permission. A VMP with its AMPs and packs, or an AMP with its VMP and packs; the dose units dm+d gives for it (the unit dose, its form size's unit and the strength units); invalid and superseded products marked.",
      security,
      request: { params: DmdIdParam },
      responses: {
        200: jsonBody(DmdProductDetail, "The product"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const { id } = c.req.valid("param");
      const today = ukDateOf(new Date());
      const found = await withTenant(c, async (tx) => ({
        release: await dmdReleaseStatus(tx),
        product: await dmdProductDetail(tx, id, today),
      }));
      if (found.product === null) {
        throw new HttpProblem(
          404,
          "not_found",
          "dm+d has no product with this code.",
          found.release.message,
        );
      }
      return c.json({ release: found.release, product: found.product }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/dmd/gtin/{gtin}",
      tags: ["medicines"],
      summary: "The packs a barcode's GTIN names",
      description:
        "Any medicines permission. A GTIN of 8, 12, 13 or 14 digits, read as GTIN-14; a wrong check digit is refused (422) rather than looked up. Only mappings in force on today's UK date and present in the release in use match; withdrawn and ended ones never do. More than one pack means the screen asks the person to choose. No match is 404.",
      security,
      request: { params: z.object({ gtin: z.string().max(20) }) },
      responses: {
        200: jsonBody(DmdGtinMatch, "The packs"),
        ...errorResponses,
        ...notFoundResponse,
      },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const gtin = toGtin14(c.req.valid("param").gtin);
      if (gtin === null) {
        throw new HttpProblem(
          422,
          "invalid_gtin",
          "This barcode number is not valid. Scan it again or type the number under the barcode.",
        );
      }
      const today = ukDateOf(new Date());
      const found = await withTenant(c, async (tx) => ({
        release: await dmdReleaseStatus(tx),
        items: await dmdGtinMatches(tx, gtin, today),
      }));
      if (found.items.length === 0) {
        throw new HttpProblem(
          404,
          "not_found",
          "No pack in the dm+d release in use has this barcode. Check the medicine against the MAR and the prescription.",
          found.release.message,
        );
      }
      return c.json({ release: found.release, gtin, items: found.items }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/v1/medicines/dmd/releases",
      tags: ["medicines"],
      summary: "The dm+d release history",
      description:
        "Any medicines permission. Every release loaded, refused or failed, newest first, with what each load changed and the problems that refused it; and the release in use with whether it is out of date.",
      security,
      responses: { 200: jsonBody(DmdReleaseHistory, "The release history"), ...errorResponses },
    }),
    async (c) => {
      await requireAnyPermission(c, READERS);
      const found = await withTenant(c, async (tx) => ({
        release: await dmdReleaseStatus(tx),
        items: await dmdReleaseHistory(tx),
      }));
      return c.json(found, 200);
    },
  );

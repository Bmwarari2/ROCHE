import { dmdFixtureReleaseDirectories } from "@harbour/db/dmd";
import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockDmdReleaseSource, UnconfiguredDmdReleaseSource } from "../src/integrations/dmd";
import { loadLatestDmdRelease } from "../src/jobs/dmd";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * dm+d reference data through the API (integrations.md section 11; INTG-006, MEDS-001; ADR-0080;
 * HZ-113): the worker job loads the invented fixture releases through the mock source; search,
 * product, GTIN and history each carry the release in use and whether it is out of date; invalid
 * products are left out unless asked for; withdrawn and ended GTINs never match; a mistyped code or
 * barcode is refused rather than matched to a near one; and only members who work with medicines
 * reach it.
 */

let h: Harness;
const [FIRST, SECOND] = dmdFixtureReleaseDirectories() as [string, string];
const KEY = "medicines.dmd.stale_after_days";

const ID = {
  vtmExamplomycin: "91000011000001107",
  vmpExamplomycin250: "91000051000001106",
  vmpTestoprofen400: "91000091000001100",
  vmpExamplomycin500Old: "91000101000001106",
  vmpExamplomycin500New: "91000111000001108",
  ampExamplePharma250: "91000131000001102",
  ampSampleGenerics250: "91000141000001109",
  amppSampleGenerics250: "91000301000001108",
  uomCapsule: "91000391000001103",
  uomMg: "91000401000001100",
} as const;

const as = (who: string, path: string) =>
  h.request(path, { token: h.tokens[who], tenant: DEMO.tenantId });

interface Release {
  name: string | null;
  releasedOn: string | null;
  status: string;
  message: string;
  staleAfterDays: number;
}

async function setStaleAfter(days: number) {
  await h.db
    .pool("harbour_owner")
    .query("UPDATE rate_table SET value = $1 WHERE key = $2 AND tenant_id IS NULL", [days, KEY]);
}

const job = (directories: string[]) =>
  loadLatestDmdRelease({
    workerPool: h.db.pool("harbour_worker"),
    logger: createLogger("silent"),
    source: new MockDmdReleaseSource(directories),
  });

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-113 before any release is loaded", () => {
  it("says no release is loaded, and finds nothing", async () => {
    const res = await as("carer", "/v1/medicines/dmd/products?q=examplomycin");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { release: Release; items: unknown[] };
    expect(body.release).toMatchObject({ name: null, status: "none" });
    expect(body.release.message).toContain("No dm+d release is loaded");
    expect(body.items).toEqual([]);
  });

  it("loads nothing when no source is configured, and says so", async () => {
    const outcome = await loadLatestDmdRelease({
      workerPool: h.db.pool("harbour_worker"),
      logger: createLogger("silent"),
      source: new UnconfiguredDmdReleaseSource(),
    });
    expect(outcome).toBeNull();
    expect((await new UnconfiguredDmdReleaseSource().health()).ok).toBe(false);
  });
});

describe("hazard HZ-113 the dm+d release job (ADR-0080)", () => {
  it("loads the newest release the source has, and changes nothing when run again", async () => {
    expect((await job([FIRST]))?.status).toBe("loaded");
    expect((await job([FIRST, SECOND]))?.status).toBe("loaded");
    expect((await job([FIRST, SECOND]))?.status).toBe("already_loaded");
  });
});

describe("hazard HZ-113 search (rule 6)", () => {
  it("finds VMPs and AMPs by the start of each word, shortest first, with the release", async () => {
    await setStaleAfter(100_000);
    const res = await as("carer", "/v1/medicines/dmd/products?q=exampl%20250");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      release: Release;
      items: { id: string; kind: string; name: string; form: { name: string } | null }[];
      truncated: boolean;
      query: { kind: string; terms: string[] };
    };
    expect(body.release).toMatchObject({
      name: "fixture_dmd_1.0.0_20261026000001",
      releasedOn: "2026-10-26",
      status: "current",
    });
    expect(body.query).toEqual({ kind: "text", terms: ["exampl", "250"] });
    expect(body.items.map((i) => [i.kind, i.id])).toEqual([
      ["vmp", ID.vmpExamplomycin250],
      ["amp", ID.ampExamplePharma250],
      ["amp", ID.ampSampleGenerics250],
    ]);
    expect(body.items[0]?.form?.name).toBe("Capsule");
    expect(body.truncated).toBe(false);
  });

  it("finds a product by its dm+d code", async () => {
    const body = (await (
      await as("manager", `/v1/medicines/dmd/products?q=${ID.vmpExamplomycin250}`)
    ).json()) as { items: { id: string }[]; query: { kind: string } };
    expect(body.query.kind).toBe("code");
    expect(body.items.map((i) => i.id)).toEqual([ID.vmpExamplomycin250]);
  });

  it("hazard HZ-113 leaves invalid products out unless asked for, and then marks them", async () => {
    const hidden = (await (
      await as("carer", "/v1/medicines/dmd/products?q=testoprofen%20400")
    ).json()) as { items: unknown[] };
    expect(hidden.items).toEqual([]);
    const shown = (await (
      await as("carer", "/v1/medicines/dmd/products?q=testoprofen%20400&includeInvalid=true")
    ).json()) as { items: { id: string; invalid: boolean }[] };
    expect(shown.items.find((i) => i.id === ID.vmpTestoprofen400)).toMatchObject({
      invalid: true,
    });
    expect(shown.items.every((i) => i.invalid)).toBe(true);
  });

  it("hazard HZ-113 offers the product dm+d moved to a new identifier, never the old one, unless asked", async () => {
    type Found = { items: { id: string; supersededBy: string | null }[] };
    const plain = (await (
      await as("carer", "/v1/medicines/dmd/products?q=examplomycin%20500")
    ).json()) as Found;
    expect(plain.items.map((i) => i.id)).toContain(ID.vmpExamplomycin500New);
    expect(plain.items.map((i) => i.id)).not.toContain(ID.vmpExamplomycin500Old);
    const all = (await (
      await as("carer", "/v1/medicines/dmd/products?q=examplomycin%20500&includeInvalid=true")
    ).json()) as Found;
    expect(all.items.find((i) => i.id === ID.vmpExamplomycin500Old)?.supersededBy).toBe(
      ID.vmpExamplomycin500New,
    );
    const byCode = (await (
      await as("carer", `/v1/medicines/dmd/products?q=${ID.vmpExamplomycin500Old}`)
    ).json()) as Found;
    expect(byCode.items).toEqual([
      expect.objectContaining({
        id: ID.vmpExamplomycin500Old,
        supersededBy: ID.vmpExamplomycin500New,
      }),
    ]);
  });

  it.each([
    ["ab", "too_short"],
    ["91000051000001107", "invalid_code"],
    ["", "empty"],
  ])("hazard HZ-113 refuses %j (%s) rather than guessing", async (q, code) => {
    const res = await as("carer", `/v1/medicines/dmd/products?q=${encodeURIComponent(q)}`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(code);
  });
});

describe("hazard HZ-113 a product with its units and forms", () => {
  it("gives a VMP's form, routes, dose units, brands and packs", async () => {
    const res = await as("carer", `/v1/medicines/dmd/products/${ID.vmpExamplomycin250}`);
    expect(res.status).toBe(200);
    const { product, release } = (await res.json()) as {
      release: Release;
      product: {
        kind: string;
        vtm: { id: string } | null;
        form: { name: string };
        routes: { name: string }[];
        doseUnits: { code: string; name: string }[];
        unitDoseForm: { size: string; unit: { name: string } };
        amps: { id: string }[];
        packs: { kind: string; quantity: string; quantityUnit: { name: string } }[];
      };
    };
    expect(release.name).toBe("fixture_dmd_1.0.0_20261026000001");
    expect(product).toMatchObject({
      kind: "vmp",
      vtm: { id: ID.vtmExamplomycin },
      form: { name: "Capsule" },
      routes: [{ name: "Oral" }],
      doseUnits: [
        { code: ID.uomCapsule, name: "capsule" },
        { code: ID.uomMg, name: "mg" },
      ],
      unitDoseForm: { size: "1.000", unit: { name: "capsule" } },
    });
    expect(product.amps.map((a) => a.id)).toEqual([
      ID.ampExamplePharma250,
      ID.ampSampleGenerics250,
    ]);
    expect(product.packs).toMatchObject([
      { kind: "vmpp", quantity: "28.00", quantityUnit: { name: "capsule" } },
    ]);
  });

  it("gives an AMP's packs with only the GTINs in force today", async () => {
    const { product } = (await (
      await as("carer", `/v1/medicines/dmd/products/${ID.ampSampleGenerics250}`)
    ).json()) as {
      product: {
        kind: string;
        vmpId: string;
        name: string;
        licensedRoutes: { name: string }[];
        packs: { id: string; kind: string; gtins: string[]; legalCategory: { name: string } }[];
      };
    };
    expect(product).toMatchObject({
      kind: "amp",
      vmpId: ID.vmpExamplomycin250,
      name: "Examplomycin 250mg capsules (Sample Generics UK Ltd)",
      licensedRoutes: [{ name: "Oral" }],
    });
    expect(product.packs).toEqual([
      expect.objectContaining({
        id: ID.amppSampleGenerics250,
        kind: "ampp",
        gtins: ["02001234500036"],
        legalCategory: { code: "9101", name: "POM" },
      }),
    ]);
  });

  it("hazard HZ-113 points from a product whose identifier dm+d changed to its successor", async () => {
    const { product } = (await (
      await as("carer", `/v1/medicines/dmd/products/${ID.vmpExamplomycin500Old}`)
    ).json()) as { product: { supersededBy: string | null } };
    expect(product.supersededBy).toBe(ID.vmpExamplomycin500New);
  });

  it("is 404 for a code dm+d does not hold, and 422 for one that is not a code", async () => {
    expect((await as("carer", "/v1/medicines/dmd/products/91000981000001102")).status).toBe(404);
    expect((await as("carer", "/v1/medicines/dmd/products/not-a-code")).status).toBe(422);
  });
});

describe("hazard HZ-113 GTIN lookup (rule 7)", () => {
  it("reads a GTIN-13 as GTIN-14 and gives its pack with the AMP and VMP", async () => {
    const res = await as("carer", "/v1/medicines/dmd/gtin/2001234500012");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      release: Release;
      gtin: string;
      items: { pack: { name: string }; amp: { id: string }; vmp: { id: string } }[];
    };
    expect(body.gtin).toBe("02001234500012");
    expect(body.release.name).toBe("fixture_dmd_1.0.0_20261026000001");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      amp: { id: ID.ampExamplePharma250 },
      vmp: { id: ID.vmpExamplomycin250 },
    });
  });

  it("returns every pack a shared GTIN names, so the screen asks which", async () => {
    const body = (await (await as("carer", "/v1/medicines/dmd/gtin/02001234500081")).json()) as {
      items: { pack: { invalid: boolean }; vmp: { name: string } }[];
    };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.pack.invalid)).toEqual([false, true]);
  });

  it.each([
    ["an ended GTIN", "2001234500029"],
    ["a GTIN the newer release withdrew", "2001234500050"],
    ["a GTIN no pack has", "2001234500111"],
  ])("never matches %s (404)", async (_, gtin) => {
    const res = await as("carer", `/v1/medicines/dmd/gtin/${gtin}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { title: string }).title).toContain("No pack");
  });

  it.each([
    ["a wrong check digit", "2001234500013"],
    ["letters", "20012345000AB"],
    ["too few digits", "12345"],
  ])("refuses %s rather than looking it up (422)", async (_, gtin) => {
    const res = await as("carer", `/v1/medicines/dmd/gtin/${gtin}`);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_gtin");
  });
});

describe("hazard HZ-113 the release history and out of date said (rules 1 and 5)", () => {
  it("lists the releases newest first, with what each changed", async () => {
    const body = (await (await as("manager", "/v1/medicines/dmd/releases")).json()) as {
      release: Release;
      items: { name: string; status: string; changes: Record<string, number> }[];
    };
    expect(body.items.map((i) => [i.name, i.status])).toEqual([
      ["fixture_dmd_1.0.0_20261026000001", "loaded"],
      ["fixture_dmd_1.0.0_20261005000001", "loaded"],
    ]);
    expect(body.items[0]?.changes).toMatchObject({ vmp_invalidated: 1, gtins_withdrawn: 1 });
  });

  it("says the release is out of date on every read once it is older than the rate table allows", async () => {
    await setStaleAfter(0);
    // A tenant's own row cannot quieten the warning: the national figure is read.
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [DEMO.tenantId]);
      await client.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
         VALUES ($1, $2, 100000, 'days', 'all', '2000-01-01', 'test', 'to-verify')`,
        [DEMO.tenantId, KEY],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    for (const path of [
      "/v1/medicines/dmd/products?q=exampl",
      `/v1/medicines/dmd/products/${ID.vmpExamplomycin250}`,
      "/v1/medicines/dmd/gtin/2001234500012",
      "/v1/medicines/dmd/releases",
    ]) {
      const body = (await (await as("carer", path)).json()) as { release: Release };
      expect(body.release, path).toMatchObject({ status: "out_of_date", staleAfterDays: 0 });
      expect(body.release.message, path).toContain("out of date");
    }
    await setStaleAfter(100_000);
  });
});

describe("who may read dm+d", () => {
  it("refuses members who do not work with medicines", async () => {
    expect((await as("quality", "/v1/medicines/dmd/products?q=exampl")).status).toBe(403);
    expect((await as("quality", "/v1/medicines/dmd/gtin/2001234500012")).status).toBe(403);
    expect((await h.request("/v1/medicines/dmd/releases")).status).toBe(401);
  });

  it("asks for the second factor a medicines permission needs", async () => {
    const res = await as("nurse", "/v1/medicines/dmd/products?q=exampl");
    expect(res.status).toBe(403);
  });
});

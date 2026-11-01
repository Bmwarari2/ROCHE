import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { dmdFixtureReleaseDirectories, parseDmdRelease } from "@harbour/db/dmd";
import { checkDmdRelease, type DmdReleaseFiles } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDmdReleaseSource,
  realPeopleEnvironment,
  UnconfiguredDmdReleaseSource,
} from "../src/integrations/dmd";
import { TrudDmdReleaseSource, TrudError } from "../src/integrations/trud";
import { checkDmdFreshness, DMD_EVENTS, runDmdReleaseJob } from "../src/jobs/dmd";
import { createLogger } from "../src/logger";
import { ZipWriter } from "../src/services/zip-writer";
import { createHarness, type Harness } from "./support/harness";

/**
 * The TRUD dm+d download (integrations.md section 11, "Release download"; slice 75; HZ-113),
 * against a mock TRUD on 127.0.0.1: never the real service. The adapter honours the release source
 * port's contract; a release downloads, checks and loads; one already loaded is not downloaded
 * again; a wrong checksum, an oversized download, a redirect elsewhere, an unsafe archive and a
 * refused key stop it with a code, never the key; the job's exit status follows; and the worker's
 * daily check says when the release in use is late.
 */

const KEY = "test-trud-key-0123456789abcdef";
const [FIRST, SECOND] = dmdFixtureReleaseDirectories() as [string, string];
const releaseName = (dir: string) => dir.split("/").at(-1) ?? "";

async function zipOf(entries: readonly (readonly [string, string | Buffer])[]): Promise<Buffer> {
  const zip = new ZipWriter();
  const parts: Buffer[] = [];
  const collected = new Promise<void>((resolve, reject) => {
    zip.output.on("data", (c: Buffer) => parts.push(c));
    zip.output.on("end", resolve);
    zip.output.on("error", reject);
  });
  for (const [name, content] of entries) await zip.add(name, content);
  await zip.finish();
  await collected;
  return Buffer.concat(parts);
}

const releaseEntries = (dir: string, folder = true) =>
  readdirSync(dir).map(
    (f) => [folder ? `${releaseName(dir)}/${f}` : f, readFileSync(join(dir, f))] as const,
  );

/** What the mock TRUD serves, changed by each test. */
const trud = {
  archive: Buffer.alloc(0) as Buffer,
  archiveName: "",
  declaredBytes: undefined as number | undefined,
  declaredSha: undefined as string | undefined,
  /** Where the archive's address sends the download first (a redirect), if anywhere. */
  redirectTo: undefined as string | undefined,
  downloads: 0,
  requests: [] as string[],
};

let server: Server;
let base = "";
let host = "";

async function serve(archive: Buffer, name: string) {
  trud.archive = archive;
  trud.archiveName = `${name}.zip`;
  trud.declaredBytes = undefined;
  trud.declaredSha = undefined;
  trud.redirectTo = undefined;
}

let work: string;
const source = (limits: { maxFiles?: number; maxBytes?: number } = {}) =>
  new TrudDmdReleaseSource({
    apiKey: KEY,
    item: 24,
    baseUrl: `${base}/trud/api/v1`,
    allowedHosts: [host],
    allowHttp: true,
    workDir: work,
    limits: {
      maxFiles: limits.maxFiles ?? 64,
      maxBytes: limits.maxBytes ?? 10 * 1024 * 1024,
      maxArchiveBytes: 10 * 1024 * 1024,
    },
    timeoutMs: 10_000,
  });

/** Log lines, read back. */
function captured() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger(
    "info",
    new Writable({
      write(chunk, _encoding, done) {
        raw.push(String(chunk));
        lines.push(JSON.parse(String(chunk)) as Record<string, unknown>);
        done();
      },
    }),
  );
  return { logger, lines, raw };
}

let h: Harness;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "harbour-trud-test-"));
  server = createServer((req, res) => {
    const url = req.url ?? "";
    trud.requests.push(url);
    if (url === `/trud/api/v1/keys/${KEY}/items/24/releases?latest`) {
      const sha = createHash("sha256").update(trud.archive).digest("hex");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          apiVersion: "1",
          httpStatus: 200,
          releases: [
            {
              id: trud.archiveName,
              name: "Release",
              releaseDate: "2026-10-26",
              archiveFileName: trud.archiveName,
              archiveFileUrl: `${base}/download/${KEY}/${trud.archiveName}`,
              archiveFileSizeBytes: trud.declaredBytes ?? trud.archive.length,
              archiveFileSha256: trud.declaredSha ?? sha,
            },
          ],
        }),
      );
      return;
    }
    if (url.startsWith("/trud/api/v1/keys/")) {
      res.statusCode = 401;
      res.end(JSON.stringify({ message: "Invalid API key" }));
      return;
    }
    if (url === `/download/${KEY}/${trud.archiveName}`) {
      if (trud.redirectTo) {
        res.statusCode = 302;
        res.setHeader("location", trud.redirectTo);
        res.end();
        return;
      }
      trud.downloads += 1;
      res.setHeader("content-type", "application/zip");
      res.end(trud.archive);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  host = `127.0.0.1:${port}`;
  base = `http://${host}`;
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
  await h?.close();
});

const leftovers = () => readdirSync(work);

describe("the TRUD adapter honours the release source port (contract)", () => {
  it("downloads, checks and unpacks a release the loader accepts, and deletes it after", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    const trudSource = source();
    expect(await trudSource.peek()).toEqual({
      name: releaseName(SECOND),
      releasedOn: "2026-10-26",
    });
    const release = (await trudSource.latest()) as DmdReleaseFiles;
    expect(release).toMatchObject({
      name: releaseName(SECOND),
      releasedOn: "2026-10-26",
      source: "nhsbsa_trud",
    });
    expect(release.files.map((f) => f.name).sort()).toEqual(readdirSync(SECOND).sort());
    const parsed = await parseDmdRelease(release, {
      maxFiles: 64,
      maxBytes: 10 * 1024 * 1024,
      deadline: Date.now() + 60_000,
    });
    expect(parsed.problems).toEqual([]);
    if (parsed.content) expect(checkDmdRelease(parsed.content).problems).toEqual([]);
    expect((await trudSource.health()).ok).toBe(true);
    await trudSource.close();
    expect(leftovers()).toEqual([]);
  });

  it("unpacks files at the top of the archive and a zip nested one level (the GTIN file)", async () => {
    const all = releaseEntries(SECOND, false);
    const gtin = all.filter(([n]) => n.startsWith("f_gtin2"));
    const rest = all.filter(([n]) => !n.startsWith("f_gtin2"));
    await serve(
      await zipOf([...rest, ["week432026-r2_3-GTIN.zip", await zipOf(gtin)]]),
      releaseName(SECOND),
    );
    const trudSource = source();
    const release = (await trudSource.latest()) as DmdReleaseFiles;
    expect(release.files.map((f) => f.name).sort()).toEqual(readdirSync(SECOND).sort());
    await trudSource.close();
  });
});

describe("hazard HZ-113 what stops a download, with a code and never the key", () => {
  const refusal = async (make: () => TrudDmdReleaseSource) => {
    const trudSource = make();
    const error = await trudSource.latest().catch((e: unknown) => e);
    await trudSource.close();
    expect(leftovers()).toEqual([]);
    expect(error).toBeInstanceOf(TrudError);
    expect(String((error as Error).message)).not.toContain(KEY);
    return error as TrudError;
  };

  it("refuses an archive whose SHA-256 is not the one TRUD declared", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    trud.declaredSha = "0".repeat(64);
    expect((await refusal(source)).code).toBe("checksum_mismatch");
  });

  it("stops a download that runs past the size TRUD declared", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    trud.declaredBytes = 100;
    expect((await refusal(source)).code).toBe("download_too_large");
  });

  it("refuses a redirect to a host that is not allowed", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    trud.redirectTo = "http://evil.example.invalid/archive.zip";
    expect((await refusal(source)).code).toBe("trud_response_invalid");
  });

  it.each([
    ["a path that climbs out", [["../escape.xml", "<x/>"]]],
    ["an absolute path", [["/etc/escape.xml", "<x/>"]]],
    ["a folder that is not the release's", [["other/f_vmp2_1.xml", "<x/>"]]],
    ["a folder inside the release's", [[`${releaseName(SECOND)}/deeper/f_vmp2_1.xml`, "<x/>"]]],
    [
      "the same name twice",
      [
        ["f_vmp2_1.xml", "<x/>"],
        [`${releaseName(SECOND)}/f_vmp2_1.xml`, "<y/>"],
      ],
    ],
  ] as const)("refuses an archive with %s", async (_case, entries) => {
    await serve(await zipOf(entries), releaseName(SECOND));
    expect((await refusal(source)).code).toBe("archive_unsafe");
  });

  it("refuses a zip nested two levels", async () => {
    const inner = await zipOf([["f_gtin2_1.xml", "<x/>"]]);
    await serve(await zipOf([["a.zip", await zipOf([["b.zip", inner]])]]), releaseName(SECOND));
    expect((await refusal(source)).code).toBe("archive_unsafe");
  });

  it("refuses an archive that inflates past the release's limit (a zip bomb), or holds too many files", async () => {
    await serve(
      await zipOf([["f_vmp2_1.xml", Buffer.alloc(3 * 1024 * 1024)]]),
      releaseName(SECOND),
    );
    expect((await refusal(() => source({ maxBytes: 1024 * 1024 }))).code).toBe("archive_too_large");
    await serve(
      await zipOf(Array.from({ length: 9 }, (_, i) => [`f_x${i}.xml`, "<x/>"] as const)),
      releaseName(SECOND),
    );
    expect((await refusal(() => source({ maxFiles: 8 }))).code).toBe("archive_too_large");
  });

  /** Changes every central directory record of a zip (review L5). */
  const patchCentral = (zip: Buffer, patch: (zip: Buffer, record: number) => void) => {
    for (let i = 0; i + 4 <= zip.length; i++) if (zip.readUInt32LE(i) === 0x02014b50) patch(zip, i);
    return zip;
  };

  it("refuses an encrypted entry", async () => {
    const zip = patchCentral(await zipOf([["f_vmp2_1.xml", "<x/>"]]), (z, at) =>
      z.writeUInt16LE(z.readUInt16LE(at + 8) | 1, at + 8),
    );
    await serve(zip, releaseName(SECOND));
    expect((await refusal(source)).code).toBe("archive_unsafe");
  });

  it("refuses a symbolic link entry, even named as XML", async () => {
    const zip = patchCentral(await zipOf([["f_vmp2_1.xml", "/etc/passwd"]]), (z, at) => {
      z.writeUInt16LE((3 << 8) | 20, at + 4); // made on Unix
      z.writeUInt32LE((0o120777 << 16) >>> 0, at + 38); // a symbolic link
    });
    await serve(zip, releaseName(SECOND));
    expect((await refusal(source)).code).toBe("archive_unsafe");
  });

  it("refuses an archive of more entries than the bound, skipped ones included", async () => {
    const many = Array.from({ length: 33 }, (_, i) => [`readme${i}.txt`, "x"] as const);
    await serve(await zipOf(many), releaseName(SECOND));
    expect((await refusal(() => source({ maxFiles: 8 }))).code).toBe("archive_too_large");
  });

  it("stops after three redirects", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    trud.redirectTo = `${base}/download/${KEY}/${trud.archiveName}`;
    const error = await refusal(source);
    expect(error).toMatchObject({ code: "trud_refused", status: 302 });
  });

  it("unpacks into a private directory", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    const trudSource = source();
    await trudSource.latest();
    const [dir] = leftovers();
    expect(statSync(join(work, dir ?? "")).mode & 0o777).toBe(0o700);
    await trudSource.close();
    expect(leftovers()).toEqual([]);
  });

  it("reports a refused key by its HTTP status, and the job's log line never holds the key", async () => {
    const wrong = new TrudDmdReleaseSource({
      apiKey: "wrong-trud-key-0123456789",
      item: 24,
      baseUrl: `${base}/trud/api/v1`,
      allowedHosts: [host],
      allowHttp: true,
      workDir: work,
      limits: { maxFiles: 64, maxBytes: 1024 * 1024, maxArchiveBytes: 1024 * 1024 },
      timeoutMs: 10_000,
    });
    const { logger, lines, raw } = captured();
    const run = await runDmdReleaseJob({
      pool: h.db.pool("harbour_dmd_job"),
      logger,
      source: wrong,
    });
    expect(run.exitCode).toBe(1);
    expect(lines.at(-1)).toMatchObject({
      event: DMD_EVENTS.download_failed,
      code: "trud_refused",
      status: 401,
      provider: "trud",
    });
    expect(raw.join("")).not.toContain("wrong-trud-key");
  });

  it("reports TRUD unreachable without its address", async () => {
    const away = new TrudDmdReleaseSource({
      apiKey: KEY,
      item: 24,
      baseUrl: "http://127.0.0.1:1/trud/api/v1",
      allowedHosts: ["127.0.0.1:1"],
      allowHttp: true,
      workDir: work,
      limits: { maxFiles: 64, maxBytes: 1024 * 1024, maxArchiveBytes: 1024 * 1024 },
      timeoutMs: 5_000,
    });
    const error = await away.peek().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "trud_unreachable" });
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it("is used where real people work only with its key, and never over plain HTTP there", () => {
    const settings = {
      baseUrl: `${base}/trud/api/v1`,
      item: 24,
      allowedHosts: [host],
      maxArchiveBytes: 1024 * 1024,
      timeoutMs: 1000,
    };
    expect(createDmdReleaseSource({ production: true, trud: settings }).provider).toBe(
      "unconfigured",
    );
    const real = createDmdReleaseSource({
      production: true,
      trud: { ...settings, apiKey: KEY, allowHttp: true },
    });
    expect(real.provider).toBe("trud");
    // The plain-HTTP mock address is refused: production never downloads over HTTP.
    return expect(real.peek?.()).rejects.toMatchObject({ code: "trud_response_invalid" });
  });
});

describe("hazard HZ-113 the dm+d job (its own process) and the worker's daily check", () => {
  const job = (trudSource = source()) => {
    const log = captured();
    return runDmdReleaseJob({
      pool: h.db.pool("harbour_dmd_job"),
      logger: log.logger,
      source: trudSource,
    }).then((run) => ({ ...run, ...log }));
  };

  it("says no release is late before any is loaded only where one is expected", async () => {
    const pool = h.db.pool("harbour_worker");
    const quiet = await checkDmdFreshness({
      workerPool: pool,
      logger: captured().logger,
      expected: false,
    });
    expect(quiet).toMatchObject({ late: false, status: "none" });
    const { logger, lines } = captured();
    const loud = await checkDmdFreshness({ workerPool: pool, logger, expected: true });
    expect(loud).toMatchObject({ late: true, status: "none" });
    expect(lines.at(-1)).toMatchObject({ event: DMD_EVENTS.late, status: "none" });
  });

  it("downloads and loads a release, then does not download it again", async () => {
    await serve(await zipOf(releaseEntries(FIRST)), releaseName(FIRST));
    const first = await job();
    expect(first.exitCode).toBe(0);
    expect(first.outcome?.status).toBe("loaded");
    expect(first.lines.at(-1)).toMatchObject({ event: DMD_EVENTS.loaded, provider: "trud" });
    const downloads = trud.downloads;
    const again = await job();
    expect(again).toMatchObject({ exitCode: 0, outcome: null });
    expect(again.lines.at(-1)).toMatchObject({
      event: DMD_EVENTS.already_loaded,
      downloaded: false,
    });
    expect(trud.downloads).toBe(downloads);
    expect(leftovers()).toEqual([]);
  });

  it("loads the newer release, and fails the job when an older one is offered", async () => {
    await serve(await zipOf(releaseEntries(SECOND)), releaseName(SECOND));
    expect((await job()).outcome?.status).toBe("loaded");
    // TRUD offering a release older than the one in use: refused, and the job says so.
    const older = await zipOf(releaseEntries(FIRST, false));
    await serve(older, `${releaseName(FIRST).replace("1.0.0", "1.0.1")}`);
    const refused = await job();
    expect(refused.exitCode).toBe(1);
    expect(refused.outcome?.status).toBe("refused");
    expect(refused.lines.at(-1)).toMatchObject({ event: DMD_EVENTS.refused });
  });

  it("fails the job, with an alert, when there is no source where real people work (review M1)", async () => {
    const { logger, lines } = captured();
    const run = await runDmdReleaseJob({
      pool: h.db.pool("harbour_dmd_job"),
      logger,
      source: new UnconfiguredDmdReleaseSource(),
      expected: true,
    });
    expect(run.exitCode).toBe(1);
    expect(lines.at(-1)).toMatchObject({
      event: DMD_EVENTS.download_failed,
      code: "trud_unconfigured",
    });
  });

  it("treats any environment it does not know as one where real people work (review L4)", () => {
    for (const environment of ["uat", "preprod", "staging", "production", " Pilot "]) {
      expect(realPeopleEnvironment({ production: false, environment }), environment).toBe(true);
      expect(createDmdReleaseSource({ production: false, environment }).provider).toBe(
        "unconfigured",
      );
    }
    for (const environment of [undefined, "", "dev", "local", "ci", "test"]) {
      expect(realPeopleEnvironment({ production: false, environment }), String(environment)).toBe(
        false,
      );
    }
    expect(realPeopleEnvironment({ production: true, environment: "dev" })).toBe(true);
  });

  it("says the release in use is late after 35 days, and current up to them", async () => {
    const pool = h.db.pool("harbour_worker");
    // The release in use is dated 26/10/2026; the rate table's figure is 35 days.
    const at = (iso: string) =>
      checkDmdFreshness({
        workerPool: pool,
        logger: captured().logger,
        expected: true,
        now: new Date(iso),
      });
    expect(await at("2026-11-30T12:00:00Z")).toMatchObject({ late: false, ageDays: 35 });
    expect(await at("2026-12-01T12:00:00Z")).toMatchObject({ late: true, ageDays: 36 });
  });
});

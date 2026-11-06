# dm+d release download from TRUD (Phase 2 slice 75, INTG-006)

Branch `feat/integrations-dmd-download`, cut from `feat/meds-dmd-reference` (slice 10, migration
0110). The spec is [integrations.md](../specs/integrations.md) section 11, "Release download",
with an amendment to ADR-0080.

## What changed

- **TRUD adapter** (`apps/api/src/integrations/trud.ts`), behind the existing release source port:
  - It asks TRUD for item 24's latest release, and refuses an answer that does not name a dated
    archive on TRUD's host with its size and SHA-256.
  - It streams the archive into a private directory, checking the size and SHA-256 as it goes.
    Redirects are allowed only to TRUD's host.
  - It unpacks only plain XML file names, plus a zip nested one level deep, counting every
    inflated byte against the release's limit.
  - It hands the directory to the same reader a manual run uses, and deletes it afterwards.
  - Errors carry a code and an HTTP status, never the address or the API key.
- **The rules** are pure functions in `packages/domain/src/integrations/trud.ts`:
  `checkTrudRelease`, `trudUrlAllowed` and `dmdArchiveEntryName`. All are table-tested.
- **The release source port** gains two optional members: `peek`, so a release already loaded is
  not downloaded again, and `close`, which deletes what was downloaded.
- **Its own process.** `apps/api/src/jobs/dmd-job.ts` builds to `dist/dmd-job.js`, for a Cloud Run
  job. It exits non-zero when a release is refused, fails or cannot be downloaded.
  `pnpm --filter @harbour/api dmd:run` runs it on a machine, against the mock.
  - The shared worker no longer loads dm+d, and unschedules its old `dmd-release-load` queue.
  - It runs a daily freshness check instead (`checkDmdFreshness`, the `dmd-freshness` queue).
- **Alerts** come from structured log lines: `dmd.release.refused`, `dmd.release.failed`,
  `dmd.download.failed` and `dmd.release.late` (older than `medicines.dmd.stale_after_days`, or no
  release at all where real people work). The alert policies are H-1241.
- **Configuration:**
  - `TRUD_API_KEY` is a secret, from Secret Manager into the job only (H-1240).
  - The other settings are `TRUD_BASE_URL`, which must be https on an allowed host, `TRUD_DMD_ITEM`
    (24), `TRUD_ALLOWED_HOSTS`, `DMD_ARCHIVE_MAX_BYTES` and `DMD_WORK_DIR`.
  - Staging, pilot and production use TRUD only when the key is set, never over plain HTTP, and
    otherwise have no source.
- **Migration 0131:**
  - a login role of its own, `harbour_dmd_job` (`DATABASE_DMD_URL`), for the job: it may call
    the loader and read the dm+d tables, and nothing else;
  - `harbour_worker` loses EXECUTE on the loader;
  - `harbour_worker` may read the national rows of `rate_table`, with a restrictive policy, so the
    daily check uses the same figure as the screens.
- **Dependency:** `yauzl` 3.4.0 (MIT) for reading zip archives, and `@types/yauzl`.
- **Documents:**
  - the [dm+d release runbook](../runbooks/dmd-release.md), with what to do for each alert;
  - HZ-113's controls and verification;
  - a re-check of the medical-device boundary, which is unchanged;
  - the feature register and STATUS;
  - human actions H-1240 to H-1245: the key, the Terraform job and alerts, confirming TRUD's
    answer, sizing, who receives the alerts, and egress.

## Security review

The security reviewer found 2 high, 3 medium and 6 low findings. All are fixed or answered.

- **H1, fixed: the job's database role.** The job parsed an archive from the internet as
  `harbour_worker`, which reads and updates every organisation's outbox and notifications. It now
  has its own role, as above.
- **H2, answered: where the job runs.** The reviewer read this branch's base, from before the move
  to Google Cloud. Cloud Run in europe-west2, with the database on private IP, is ADR-0098, which
  arrives with #164. ADR-0080's amendment now cites it.
- **M1, fixed.** Where real people work, a missing key or no release now fails the job and logs
  `dmd.download.failed` with `trud_unconfigured`. It no longer passes quietly for 35 days.
- **M2, fixed.** Every entry counts against the bound (four times the file limit), skipped ones
  included.
- **M3, fixed.** `DMD_ARCHIVE_MAX_BYTES` defaults to 256 MiB, and SIGTERM deletes the work
  directory. H-1241 now sizes the job's memory, since Cloud Run's `/tmp` is memory.
- **Lows, fixed:**
  - L1: the archive is checked and unpacked through one open file descriptor.
  - L3: encrypted entries, symbolic links and devices are refused.
  - L4: one list of fixture environments, so anything else counts as an environment where real
    people work.
  - L5: tests added for encrypted entries, symbolic links, the entry bound, a redirect loop and the
    private directory.
  - L6: one deadline for the whole run, and 30 seconds for TRUD's answer.
- **L2, recorded.** The SHA-256 comes from the same answer as the address, and TRUD publishes no
  signature. This is a residual risk in HZ-113 and ADR-0080.

## Not done here

- **The job's Terraform** (the Cloud Run job, Cloud Scheduler, egress and alert policies) waits
  for the Google Cloud integration (#164): H-1241.
- **The real TRUD service:** no call has been made to it. The adapter is tested only against a mock
  TRUD on 127.0.0.1, and TRUD's field names are confirmed with the first real run (H-1242).

## Data protection and clinical safety

dm+d holds no personal data, and TRUD receives only the account's key, so it is not a
sub-processor. The change is clinical (HZ-113), and the hazard log is updated in this change.

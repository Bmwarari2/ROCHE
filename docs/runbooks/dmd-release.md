# dm+d release download and load

The monthly dm+d release comes from TRUD and is loaded into the national reference tables
([integrations.md](../specs/integrations.md) section 11, "Release download"; ADR-0080; HZ-113).
Wrong, stale or half-loaded dm+d data shows the wrong product, unit or pack, so every step below
leaves the release in use unchanged until a whole new one has loaded.

## How it runs

- **Where:** a Cloud Run job, `harbour-<env>-dmd`, running `node dist/dmd-job.js` as its own
  database role, `harbour_dmd_job` (`DATABASE_DMD_URL`). That role may only call the dm+d loader and
  read the dm+d tables. The job is never run in the shared worker, and the worker may no longer
  call the loader. Cloud Scheduler starts it monthly, early on
  the 3rd (H-1241).
- **What one run does:**
  1. asks TRUD for the latest release of item 24;
  2. stops, without downloading, if that release is already loaded (`dmd.release.already_loaded`,
     `downloaded: false`);
  3. otherwise downloads the archive into a private directory, checking its size and SHA-256;
  4. unpacks only plain XML file names, within the limits;
  5. loads the release whole or not at all;
  6. deletes the files.
- **Exit status:** non-zero when the release is refused, fails or cannot be downloaded, so the job
  execution shows as failed too.
- **Daily check:** the shared worker logs `dmd.release.late` once the release in use is older than
  `medicines.dmd.stale_after_days` (35 days), or when none is loaded where real people work. Every
  medicines screen says the same in words.
- **Secrets:** the TRUD API key reaches the job only, from Secret Manager (`TRUD_API_KEY`, H-1240).
  It is never in a log line. A log line carries the release's name and date, the problem codes and
  an HTTP status, nothing else.

## Alerts and what to do

| Log event | Most likely cause | What to do |
| --- | --- | --- |
| `dmd.download.failed`, `code: trud_refused`, `status: 401` or `403` | The TRUD key lapsed or was revoked, or the subscription to item 24 ended | Renew or reissue the key in TRUD, put the new one in the secret (H-1240), and run the job again |
| `dmd.download.failed`, `code: trud_unconfigured` | `TRUD_API_KEY` is not reaching the job (the secret binding was dropped, or never set) | Bind the secret to the job (H-1240) and run it again; the job fails until then rather than passing quietly |
| `dmd.download.failed`, `code: database_unconfigured` | `DATABASE_DMD_URL` is not set for the job | Set it from the `harbour_dmd_job` password secret (H-1241) |
| `dmd.download.failed`, `code: trud_unreachable` | TRUD is down, or egress to `isd.digital.nhs.uk` is blocked (H-1245) | Check TRUD's service status and the egress rule, then run the job again; the release in use stays in use |
| `dmd.download.failed`, `code: trud_response_invalid` | TRUD changed its answer, or the archive's address or a redirect points off TRUD's host | Look at TRUD's answer by hand (from a machine, never by pasting the key into a ticket). If TRUD changed its fields, update `checkTrudRelease` and its tests (H-1242). An address off TRUD's host is never followed |
| `dmd.download.failed`, `code: checksum_mismatch` or `download_too_large` | A corrupted or altered download, or a proxy changing it | Run the job again. If it repeats, treat it as a security event ([incident-response.md](incident-response.md)) and tell NHSBSA |
| `dmd.download.failed`, `code: archive_unsafe` or `archive_too_large` | A name inside the archive could reach outside its directory, or the archive inflates past the limit | Do not load it by hand. If the release is genuine and only larger, raise the limits after measuring it (H-1243) |
| `dmd.release.refused` | The release failed a check, for example a concept in use missing with no successor, or a file the parser cannot read | Read the problems in the release history (`GET /v1/medicines/dmd/releases`). Follow H-653: a corrected or later release loads at the next run, or run the job by hand once NHSBSA re-issues it |
| `dmd.release.failed` | A database error or the time limit (`timed_out`) | Check the database and the job's timeout (H-1243), then run the job again; nothing half-loaded is ever used |
| `dmd.release.late` | No release has loaded for more than 35 days: the job has not run, or every run failed | Find the failed runs above and fix them. Until a release loads, every medicines screen warns that the data is out of date |

## Run it by hand

- **Deployed:** run an execution of the Cloud Run job `harbour-<env>-dmd`. It is safe to run at any
  time: a release already loaded is not downloaded again.
- **On a developer's machine:** `pnpm --filter @harbour/api dmd:run` loads the newest invented
  fixture release through the mock and never calls TRUD.
- **A release placed by hand** (for example to check the parser, H-654):
  `pnpm --filter @harbour/db dmd:load <release directory>`, as `harbour_owner`, outside Git.

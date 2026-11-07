# Terraform for the monthly dm+d download (H-1241)

Branch `feat/infra-dmd-download`, no PR yet.

## What changed

- A Cloud Run job, `harbour-<env>-dmd`, runs `node apps/api/dist/dmd-job.js` from the api image as
  its own service account. It has 2 CPUs and 6Gi, because the archive and the unpacked release sit
  in `/tmp`, which is memory (H-1243). It has a 90-minute task timeout (the 60-minute load limit
  plus the download), one task at a time and one retry. The run is idempotent, and the database
  loads one release at a time.
- `harbour_dmd_job` joins the database login roles. This creates its password and URL secrets, and
  the migrate job gets `HARBOUR_DB_PASSWORD_HARBOUR_DMD_JOB` for the bootstrap. `DATABASE_DMD_URL`
  is bound to the dm+d job only. `trud-api-key` exists in staging and prod only, and only the job
  reads it (`TRUD_API_KEY`). Dev uses the invented fixture.
- Cloud Scheduler `harbour-<env>-dmd-monthly` (`17 3 3 * *`, Europe/London) calls the Cloud Run
  Admin API as its own account, which may start this job only. The `cloudscheduler.googleapis.com`
  API is on, and the deploy account gets `roles/cloudscheduler.admin` at the next bootstrap apply
  (H-1502).
- Alerts: log-based metrics and policies on `dmd.release.refused`, `dmd.release.failed` and
  `dmd.download.failed` (the job's logs) and `dmd.release.late` (the worker's daily check), and an
  alert on any failed execution of the job.
- The release workflow moves the dm+d job to each new api image.
- `seed-secrets.sh` refreshes the new role's URL and explains where the TRUD key comes from.
- Plan tests: the job, its retries and timeout, the secrets bound to the job only, the scheduler's
  time zone, and the alert filters. Updated the README, the dm+d runbook, and H-1241 and H-1245.
  Added H-1501 to H-1505.
- No bucket: the job downloads into a private temporary directory and deletes the files.
- No egress firewall: the VPC has none, and a rule by host name needs Cloud NGFW. The job refuses
  any host but `isd.digital.nhs.uk` itself (H-1245).

## What is next

- Brian applies it: the TRUD key, the bootstrap, the first apply and a run by hand (H-1501 to
  H-1504).
- The job runs with `NODE_ENV=production` and checks only its own settings
  (`loadDmdJobConfig` in `apps/api/src/config.ts`), so it holds none of the API's secrets (H-1505).

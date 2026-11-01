# ---------------------------------------------------------------------------------------------
# Secrets
#
# Terraform creates empty regional secrets only. Values are generated inside Google Cloud by
# infra/scripts/seed-secrets.sh (once per environment) so that no password ever appears in
# Terraform state or plan output, and the plan account never needs secretAccessor. Each secret
# holds one value: Cloud Run reads a whole secret version into one variable or file.
# ---------------------------------------------------------------------------------------------

locals {
  # Login roles on the main database, created by `pnpm db:bootstrap` (packages/db, ADR-0002).
  db_login_roles = ["harbour_owner", "harbour_app", "harbour_auth", "harbour_sync", "harbour_operator", "harbour_worker"]

  secret_definitions = merge(
    merge([
      for r in concat(local.db_login_roles, ["powersync_storage"]) : {
        "db-${r}-password" = "Password of the ${r} database role"
        "db-${r}-url"      = "Connection URL of the ${r} database role (TLS, server CA verified)"
      }
    ]...),
    {
      "db-admin-password"            = "Password of the postgres user on the main instance (used by the migrate job only)"
      "db-sync-admin-password"       = "Password of the postgres user on the sync-storage instance"
      "db-server-ca"                 = "The Cloud SQL server CA certificates (PEM) the services verify"
      "api-auth-secret"              = "Better Auth secret"
      "api-evidence-link-secret"     = "HMAC key for evidence pack codes and link sessions (ADR-0050)"
      "api-speak-up-throttle-secret" = "Key for the network hash in the public speak-up limits (ADR-0089)"
      "api-sync-signing-key-pem"     = "Private key that signs PowerSync tokens"
      "api-sync-signing-key-id"      = "Key ID of the PowerSync signing key"
      "powersync-api-token"          = "Token for the PowerSync admin API"
      "smtp-user"                    = "User name for the SMTP relay"
      "smtp-password"                = "Password for the SMTP relay"
    },
    var.enable_flagsmith ? {
      "flagsmith-django-secret-key" = "Flagsmith Django secret key"
      "flagsmith-database-password" = "Flagsmith database password"
    } : {},
  )

  # Full ids built from known names, so a plan can count every grant before the secrets exist.
  secret = {
    for k in keys(local.secret_definitions) :
    k => "projects/${var.project_id}/locations/${var.region}/secrets/${local.name_prefix}-${k}"
  }

  # The Cloud SQL server CA is mounted as a file (the API image bundles no CA); connection URLs
  # name it (sslrootcert) and NODE_EXTRA_CA_CERTS points at it. Private IP and TLS: no Auth
  # Proxy or connector.
  db_ca_volume = {
    cloudsql = { secret = local.secret["db-server-ca"], mount_path = "/secrets/cloudsql", file = "server-ca.pem" }
  }
  db_ca_file = "/secrets/cloudsql/server-ca.pem"
}

module "secrets" {
  source = "../secret_manager"

  project_id  = var.project_id
  region      = var.region
  name_prefix = local.name_prefix
  secrets     = local.secret_definitions
  kms_key_id  = module.kms.key_ids["secrets"]
  labels      = local.labels

  depends_on = [module.kms]
}

# ---------------------------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------------------------

module "db_main" {
  source = "../cloud_sql_postgres"

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-main"
  database_name = "harbour"
  tier          = var.main_db_tier
  edition       = var.db_edition
  disk_size_gb  = var.main_db_disk_gb

  high_availability              = var.db_high_availability
  transaction_log_retention_days = var.db_pitr_days
  deletion_protection            = var.db_deletion_protection

  network_id                  = module.network.network_id
  private_services_connection = module.network.private_services_connection
  kms_key_id                  = module.kms.key_ids["sql"]

  # PowerSync streams changes from this database.
  logical_decoding = true
  labels           = local.labels

  depends_on = [module.kms]
}

# PowerSync bucket storage: holds per-bucket copies of synced rows, so it is personal data and
# gets the same hardening. It can be rebuilt from the main database by a PowerSync resync.
# Flagsmith's database, when enabled, also lives here (tenant identifiers only).
module "db_sync_storage" {
  source = "../cloud_sql_postgres"

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-sync-storage"
  database_name = "powersync_storage"
  tier          = var.sync_storage_db_tier
  edition       = var.db_edition
  disk_size_gb  = var.sync_storage_db_disk_gb

  high_availability              = var.db_high_availability
  transaction_log_retention_days = var.db_pitr_days
  deletion_protection            = var.db_deletion_protection

  network_id                  = module.network.network_id
  private_services_connection = module.network.private_services_connection
  kms_key_id                  = module.kms.key_ids["sql"]
  labels                      = local.labels

  depends_on = [module.kms]
}

# ---------------------------------------------------------------------------------------------
# Buckets
# ---------------------------------------------------------------------------------------------

# Usage logs of the other buckets. Only Cloud Storage's own logging account may write here.
module "bucket_logs" {
  source = "../gcs_bucket"

  project_id                   = var.project_id
  name                         = "${var.project_id}-bucket-logs"
  kms_key_id                   = module.kms.key_ids["storage"]
  delete_after_days            = 400
  noncurrent_delete_after_days = 30
  force_destroy                = var.force_destroy_buckets
  labels                       = local.labels

  depends_on = [module.kms]
}

resource "google_storage_bucket_iam_member" "usage_logs_writer" {
  bucket = module.bucket_logs.name
  role   = "roles/storage.objectCreator"
  member = "group:cloud-storage-analytics@google.com"
}

# Care documents, photos and attachments. Uploads and downloads stream through the API: no
# signed URLs and no browser access, so the bucket needs no CORS.
module "bucket_documents" {
  source = "../gcs_bucket"

  project_id        = var.project_id
  name              = "${var.project_id}-documents"
  kms_key_id        = module.kms.key_ids["storage"]
  access_log_bucket = module.bucket_logs.name
  force_destroy     = var.force_destroy_buckets
  labels            = local.labels

  depends_on = [module.kms]
}

# Generated exports. Tenant data exports and inspector PDFs (under tenants/) expire after 30
# days; issued DSAR bundles (under dsar/) are kept with their case for its retention class
# (data_rights_case) and destroyed by the retention engine with it.
module "bucket_exports" {
  source = "../gcs_bucket"

  project_id                   = var.project_id
  name                         = "${var.project_id}-exports"
  kms_key_id                   = module.kms.key_ids["storage"]
  delete_after_days            = 30
  delete_after_days_prefix     = ["tenants/"]
  noncurrent_delete_after_days = 7
  access_log_bucket            = module.bucket_logs.name
  force_destroy                = var.force_destroy_buckets
  labels                       = local.labels

  depends_on = [module.kms]
}

# Write-once archive of audit_event batches and destruction certificates (section 5.5): a
# retention policy keeps every object for audit_archive_retention_days, locked in prod.
module "bucket_audit_archive" {
  source = "../gcs_bucket"

  project_id                   = var.project_id
  name                         = "${var.project_id}-audit-archive"
  kms_key_id                   = module.kms.key_ids["storage"]
  retention_days               = var.audit_archive_retention_days
  lock_retention_policy        = local.lock_audit_archive
  noncurrent_delete_after_days = null
  soft_delete_days             = 0
  access_log_bucket            = module.bucket_logs.name
  force_destroy                = var.force_destroy_buckets && !local.lock_audit_archive
  labels                       = local.labels

  depends_on = [module.kms, terraform_data.locks_only_in_prod]
}

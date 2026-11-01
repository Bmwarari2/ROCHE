# ---------------------------------------------------------------------------------------------
# Shared configuration
# ---------------------------------------------------------------------------------------------

locals {
  # Hops between a person and the API that append to X-Forwarded-For: the load balancer's
  # address and Google's front ends, and Harbour's own NAT addresses (the web tier calling the
  # API through the load balancer). The API skips these from the right to find the client
  # address for sign-in throttling, so each person is counted, never the web tier as one client.
  nat_cidrs = [for ip in module.network.nat_addresses : "${ip}/32"]
  trusted_proxy_cidrs = concat(
    ["${module.load_balancer.ip_address}/32", "35.191.0.0/16", "130.211.0.0/22"],
    local.nat_cidrs,
  )

  # Plain configuration for the API and the worker (one bundle, two commands). Never secrets.
  # ClamAV runs beside the API (human action H-16); until it answers, uploads stay quarantined.
  # Organisations' single sign-on keys are regional secrets in this project, each added and
  # granted to the API's service account by Thapsus (ADR-0091, ADR-0098, H-751).
  app_environment = merge(
    {
      NODE_ENV                 = "production"
      HARBOUR_ENV              = var.environment
      SAFETY_CASE_VERSION      = var.safety_case_version
      GCP_PROJECT_ID           = var.project_id
      NODE_EXTRA_CA_CERTS      = local.db_ca_file
      BETTER_AUTH_URL          = "https://${local.hosts.api}"
      WEB_ORIGINS              = "https://${local.hosts.web}"
      PASSKEY_RP_ID            = var.domain_name
      TRUSTED_PROXY_CIDRS      = join(",", local.trusted_proxy_cidrs)
      POWERSYNC_URL            = "https://${local.hosts.sync}"
      SYNC_JWT_AUDIENCE        = var.sync_jwt_audience
      DOCUMENT_STORAGE         = "gcs"
      GCS_DOCUMENTS_BUCKET     = module.bucket_documents.name
      GCS_EXPORTS_BUCKET       = module.bucket_exports.name
      GCS_KMS_KEY              = module.kms.key_ids["storage"]
      GCS_AUDIT_ARCHIVE_BUCKET = module.bucket_audit_archive.name
      MALWARE_SCANNER          = "clamd"
      CLAMD_HOST               = "127.0.0.1"
      CLAMD_PORT               = "3310"
      EMAIL_FROM_DOMAIN        = coalesce(var.email_from_domain, var.domain_name)
      SSO_KEY_STORE            = "gcp"
    },
    # Unset until an email provider is chosen.
    var.smtp == null ? {} : {
      SMTP_HOST = var.smtp.host
      SMTP_PORT = tostring(var.smtp.port)
      SMTP_TLS  = tostring(var.smtp.tls)
    },
  )

  # Read from Secret Manager at instance start. Connection URLs carry sslmode=verify-ca and the
  # mounted server CA, written by infra/scripts/seed-secrets.sh.
  app_secrets = merge(
    {
      DATABASE_APP_URL         = local.secret["db-harbour_app-url"]
      DATABASE_AUTH_URL        = local.secret["db-harbour_auth-url"]
      DATABASE_OPERATOR_URL    = local.secret["db-harbour_operator-url"]
      DATABASE_WORKER_URL      = local.secret["db-harbour_worker-url"]
      BETTER_AUTH_SECRET       = local.secret["api-auth-secret"]
      EVIDENCE_LINK_SECRET     = local.secret["api-evidence-link-secret"]
      ELEARNING_LAUNCH_SECRET  = local.secret["api-elearning-launch-secret"]
      SPEAK_UP_THROTTLE_SECRET = local.secret["api-speak-up-throttle-secret"]
      SYNC_SIGNING_KEY_PEM     = local.secret["api-sync-signing-key-pem"]
      SYNC_SIGNING_KEY_ID      = local.secret["api-sync-signing-key-id"]
    },
    { for r in ["harbour_app", "harbour_auth", "harbour_worker"] : "HARBOUR_DB_PASSWORD_${upper(r)}" => local.secret["db-${r}-password"] },
    var.smtp == null ? {} : {
      SMTP_USER     = local.secret["smtp-user"]
      SMTP_PASSWORD = local.secret["smtp-password"]
    },
  )

  sync_config_file = coalesce(var.sync_config_path, "${path.module}/../../../packages/sync/src/streams/sync-config.yaml")

  # PowerSync reads one YAML file (infra/powersync/powersync.yaml, shared with Docker Compose)
  # whose environment-specific values all come from PS_* variables set below.
  powersync_config_b64 = filebase64("${path.module}/../../powersync/powersync.yaml")
  sync_config_b64      = fileexists(local.sync_config_file) ? filebase64(local.sync_config_file) : base64encode("# sync config missing at plan time\n")
}

check "sync_config_present" {
  assert {
    condition     = fileexists(local.sync_config_file)
    error_message = "PowerSync sync config not found at ${local.sync_config_file}; the powersync service would start without sync streams."
  }
}

# ---------------------------------------------------------------------------------------------
# API (Hono), with ClamAV beside it
# ---------------------------------------------------------------------------------------------

module "svc_api" {
  source = "../cloud_run_service"

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-api"
  image         = local.images.api
  command       = var.api_command
  port          = local.ports.api
  cpu           = local.sizes.api.cpu
  memory        = local.sizes.api.memory
  min_instances = local.sizes.api.min
  max_instances = local.sizes.api.max
  health_path   = var.api_health_check_path

  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  behind_load_balancer = true

  env            = merge(local.app_environment, { APP_VERSION = var.initial_image_tag })
  secret_env     = local.app_secrets
  secret_volumes = local.db_ca_volume

  # ClamAV shares the API's network namespace and listens on 127.0.0.1:3310, where the API's
  # ClamdScanner expects it. It keeps its CPU so signature updates run between requests.
  cpu_always_allocated = true
  sidecars = [{
    name       = "clamav"
    image      = local.images.clamav
    cpu        = "1"
    memory     = "3Gi"
    probe_port = 3310
    env        = { CLAMAV_NO_MILTERD = "true", CLAMD_STARTUP_TIMEOUT = "300" }
  }]

  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  depends_on = [module.secrets]
}

# ---------------------------------------------------------------------------------------------
# Worker (pg-boss jobs: notifications, schedules, exports, integrations). Never reached from
# outside: internal ingress, and its CPU stays allocated between requests so jobs keep running.
# ---------------------------------------------------------------------------------------------

module "svc_worker" {
  source = "../cloud_run_service"

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-worker"
  image         = local.images.api
  command       = var.worker_command
  port          = local.ports.api
  cpu           = local.sizes.worker.cpu
  memory        = local.sizes.worker.memory
  min_instances = local.sizes.worker.min
  max_instances = local.sizes.worker.max

  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  cpu_always_allocated = true

  env            = merge(local.app_environment, { APP_VERSION = var.initial_image_tag, PORT = tostring(local.ports.api) })
  secret_env     = local.app_secrets
  secret_volumes = local.db_ca_volume

  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  depends_on = [module.secrets]
}

# What the API and worker may do with buckets: read and write documents and exports, and append
# to the audit archive (create only; no read, overwrite or delete). No signed URLs: downloads
# stream through the API.
locals {
  app_accounts = {
    api    = module.svc_api.service_account_member
    worker = module.svc_worker.service_account_member
  }
  app_bucket_grants = merge([
    for who, member in local.app_accounts : {
      "${who}-documents" = { bucket = module.bucket_documents.name, role = "roles/storage.objectUser", member = member }
      "${who}-exports"   = { bucket = module.bucket_exports.name, role = "roles/storage.objectUser", member = member }
      "${who}-audit"     = { bucket = module.bucket_audit_archive.name, role = "roles/storage.objectCreator", member = member }
    }
  ]...)
}

resource "google_storage_bucket_iam_member" "app" {
  for_each = local.app_bucket_grants

  bucket = each.value.bucket
  role   = each.value.role
  member = each.value.member
}

# ---------------------------------------------------------------------------------------------
# Database bootstrap and migrations: a Cloud Run job, run on demand by the deploy workflow
# (gcloud run jobs execute) before new application revisions take traffic.
# ---------------------------------------------------------------------------------------------

module "job_migrate" {
  source = "../cloud_run_service"

  project_id      = var.project_id
  region          = var.region
  kind            = "job"
  name            = "${local.name_prefix}-migrate"
  image           = local.images.api
  command         = var.migrate_command
  cpu             = local.sizes.migrate.cpu
  memory          = local.sizes.migrate.memory
  timeout_seconds = 1800

  env = {
    NODE_ENV                = "production"
    HARBOUR_ENV             = var.environment
    APP_VERSION             = var.initial_image_tag
    NODE_EXTRA_CA_CERTS     = local.db_ca_file
    DATABASE_HOST           = module.db_main.private_ip
    DATABASE_PORT           = "5432"
    DATABASE_NAME           = module.db_main.database_name
    DATABASE_SSL_MODE       = "verify-ca"
    DATABASE_ADMIN_USER     = "postgres"
    SYNC_STORAGE_HOST       = module.db_sync_storage.private_ip
    SYNC_STORAGE_PORT       = "5432"
    SYNC_STORAGE_DATABASE   = module.db_sync_storage.database_name
    SYNC_STORAGE_ADMIN_USER = "postgres"
  }
  secret_env = merge(
    {
      DATABASE_ADMIN_PASSWORD               = local.secret["db-admin-password"]
      DATABASE_OWNER_URL                    = local.secret["db-harbour_owner-url"]
      SYNC_STORAGE_ADMIN_PASSWORD           = local.secret["db-sync-admin-password"]
      HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE = local.secret["db-powersync_storage-password"]
    },
    { for r in local.db_login_roles : "HARBOUR_DB_PASSWORD_${upper(r)}" => local.secret["db-${r}-password"] },
  )
  secret_volumes = local.db_ca_volume

  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  depends_on = [module.secrets]
}

# ---------------------------------------------------------------------------------------------
# Web (Next.js). Reached only through the load balancer; never opens a database connection.
# ---------------------------------------------------------------------------------------------

module "svc_web" {
  source = "../cloud_run_service"

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-web"
  image         = local.images.web
  port          = local.ports.web
  cpu           = local.sizes.web.cpu
  memory        = local.sizes.web.memory
  min_instances = local.sizes.web.min
  max_instances = local.sizes.web.max
  health_path   = var.web_health_check_path

  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  behind_load_balancer = true

  env = {
    NODE_ENV                = "production"
    HARBOUR_ENV             = var.environment
    HOSTNAME                = "0.0.0.0"
    API_BASE_URL            = "https://${local.hosts.api}"
    PUBLIC_WEB_URL          = "https://${local.hosts.web}"
    ELEARNING_ORIGIN        = local.learn_enabled ? "https://${local.hosts.learn}" : ""
    TRUSTED_PROXY_CIDRS     = join(",", local.trusted_proxy_cidrs)
    NEXT_TELEMETRY_DISABLED = "1"
  }

  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  deletion_protection = var.deletion_protection
  labels              = local.labels
}

# ---------------------------------------------------------------------------------------------
# PowerSync (self-hosted, unified API and replication process): always one instance with its
# CPU allocated, so replication never stops. Replicates from the main database as harbour_sync
# and keeps bucket data in the sync-storage database. Clients authenticate with JWTs the API
# signs; PowerSync verifies them against the API's JWKS.
# ---------------------------------------------------------------------------------------------

module "svc_powersync" {
  source = "../cloud_run_service"

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-powersync"
  image         = local.images.powersync
  args          = ["start", "-r", "unified"]
  port          = local.ports.powersync
  cpu           = local.sizes.powersync.cpu
  memory        = local.sizes.powersync.memory
  min_instances = max(1, local.sizes.powersync.min)
  max_instances = local.sizes.powersync.max
  health_path   = "/probes/liveness"

  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  behind_load_balancer = true
  cpu_always_allocated = true
  timeout_seconds      = 3600

  env = {
    POWERSYNC_CONFIG_B64      = local.powersync_config_b64
    POWERSYNC_SYNC_CONFIG_B64 = local.sync_config_b64
    NODE_EXTRA_CA_CERTS       = local.db_ca_file
    PS_PORT                   = tostring(local.ports.powersync)
    PS_DATA_SOURCE_HOST       = module.db_main.private_ip
    PS_DATA_SOURCE_PORT       = "5432"
    PS_DATA_SOURCE_DATABASE   = module.db_main.database_name
    PS_DATA_SOURCE_USER       = "harbour_sync"
    PS_DATA_SOURCE_SSLMODE    = "verify-ca"
    PS_STORAGE_HOST           = module.db_sync_storage.private_ip
    PS_STORAGE_PORT           = "5432"
    PS_STORAGE_DATABASE       = module.db_sync_storage.database_name
    PS_STORAGE_USER           = "powersync_storage"
    PS_STORAGE_SSLMODE        = "verify-ca"
    PS_JWKS_URL               = "https://${local.hosts.api}/v1/sync/jwks"
    PS_JWT_AUDIENCE           = var.sync_jwt_audience
    PS_BLOCK_LOCAL_JWKS       = "true"
  }
  secret_env = {
    PS_DATA_SOURCE_PASSWORD = local.secret["db-harbour_sync-password"]
    PS_STORAGE_PASSWORD     = local.secret["db-powersync_storage-password"]
    PS_API_TOKEN            = local.secret["powersync-api-token"]
  }
  secret_volumes = local.db_ca_volume

  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  depends_on = [module.secrets]
}

# ---------------------------------------------------------------------------------------------
# Flagsmith (optional placeholder, off by default). Its database lives on the sync-storage
# instance; feature flag state holds tenant identifiers only, never personal data.
# ---------------------------------------------------------------------------------------------

module "svc_flagsmith" {
  source = "../cloud_run_service"
  count  = var.enable_flagsmith ? 1 : 0

  project_id    = var.project_id
  region        = var.region
  name          = "${local.name_prefix}-flagsmith"
  image         = local.images.flagsmith
  port          = local.ports.flagsmith
  cpu           = local.sizes.flagsmith.cpu
  memory        = local.sizes.flagsmith.memory
  min_instances = local.sizes.flagsmith.min
  max_instances = local.sizes.flagsmith.max
  health_path   = "/health/liveness/"

  ingress              = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  behind_load_balancer = true

  env = {
    DJANGO_ALLOWED_HOSTS              = local.hosts.flags
    DJANGO_DB_HOST                    = module.db_sync_storage.private_ip
    DJANGO_DB_PORT                    = "5432"
    DJANGO_DB_NAME                    = "flagsmith"
    DJANGO_DB_USER                    = "flagsmith"
    ENVIRONMENT                       = "production"
    PREVENT_SIGNUP                    = "true"
    ENABLE_TELEMETRY                  = "false"
    ALLOW_REGISTRATION_WITHOUT_INVITE = "false"
  }
  secret_env = {
    DJANGO_SECRET_KEY  = local.secret["flagsmith-django-secret-key"]
    DJANGO_DB_PASSWORD = local.secret["flagsmith-database-password"]
  }

  network_id          = module.network.network_id
  subnet_id           = module.network.subnet_id
  deletion_protection = var.deletion_protection
  labels              = local.labels

  depends_on = [module.secrets]
}

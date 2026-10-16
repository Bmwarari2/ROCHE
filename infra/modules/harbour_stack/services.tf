# ---------------------------------------------------------------------------------------------
# ECS cluster
# ---------------------------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.name_prefix

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---------------------------------------------------------------------------------------------
# Shared configuration
# ---------------------------------------------------------------------------------------------

# CloudFront's addresses towards origins: requests through CloudFront arrive from these.
data "aws_ec2_managed_prefix_list" "cloudfront_origin_facing" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

locals {
  # Services reference the cluster through the capacity provider association so that they
  # are only created once Fargate and Fargate Spot are attached.
  cluster_name = aws_ecs_cluster_capacity_providers.this.cluster_name

  # Hops between a person and the API that append to X-Forwarded-For: CloudFront (web), the web
  # tier and load balancers in the VPC, and the NAT gateways the web tier calls the API through.
  # The API skips these from the right to find the client address for sign-in throttling.
  trusted_proxy_cidrs = concat(
    [var.vpc_cidr_block],
    [for ip in module.network.nat_public_ips : "${ip}/32"],
    sort([for entry in data.aws_ec2_managed_prefix_list.cloudfront_origin_facing.entries : entry.cidr]),
  )

  # Plain configuration for the API and the worker (one bundle, two commands). Never secrets.
  # ClamAV runs beside the API (human action H-16); until it answers, uploads stay quarantined.
  app_environment = {
    NODE_ENV                = "production"
    HARBOUR_ENV             = var.environment
    APP_VERSION             = local.image_tags["api"]
    AWS_REGION              = local.region
    NODE_EXTRA_CA_CERTS     = var.rds_ca_bundle_path
    BETTER_AUTH_URL         = "https://${local.hosts.api}"
    WEB_ORIGINS             = "https://${local.hosts.web}"
    PASSKEY_RP_ID           = var.domain_name
    TRUSTED_PROXY_CIDRS     = join(",", local.trusted_proxy_cidrs)
    POWERSYNC_URL           = "https://${local.hosts.sync}"
    SYNC_JWT_AUDIENCE       = var.sync_jwt_audience
    DOCUMENT_STORAGE        = "s3"
    S3_DOCUMENTS_BUCKET     = module.bucket_documents.bucket_id
    MALWARE_SCANNER         = "clamd"
    CLAMD_HOST              = "127.0.0.1"
    S3_EXPORTS_BUCKET       = module.bucket_exports.bucket_id
    S3_AUDIT_ARCHIVE_BUCKET = module.bucket_audit_archive.bucket_id
    SES_CONFIGURATION_SET   = module.ses.configuration_set_name
    EMAIL_FROM_DOMAIN       = var.domain_name
  }

  # Injected from Secrets Manager at task start. The db/* secrets hold username, password and
  # a ready-made url (sslmode=verify-full) written by infra/scripts/seed-secrets.sh.
  app_secrets = merge(
    {
      DATABASE_APP_URL      = "${local.secret_arns["db/harbour_app"]}:url::"
      DATABASE_AUTH_URL     = "${local.secret_arns["db/harbour_auth"]}:url::"
      DATABASE_OPERATOR_URL = "${local.secret_arns["db/harbour_operator"]}:url::"
      DATABASE_WORKER_URL   = "${local.secret_arns["db/harbour_worker"]}:url::"
      BETTER_AUTH_SECRET    = "${local.secret_arns["api"]}:auth_secret::"
      EVIDENCE_LINK_SECRET  = "${local.secret_arns["api"]}:evidence_link_secret::"
      SYNC_SIGNING_KEY_PEM  = "${local.secret_arns["api"]}:sync_signing_key_pem::"
      SYNC_SIGNING_KEY_ID   = "${local.secret_arns["api"]}:sync_signing_key_id::"
    },
    { for r in ["harbour_app", "harbour_auth", "harbour_worker"] : "HARBOUR_DB_PASSWORD_${upper(r)}" => "${local.secret_arns["db/${r}"]}:password::" },
  )

  # What the API and worker may do in AWS: read and write documents and exports, append to
  # the audit archive (no read or delete), and send email through the configuration set.
  app_task_statements = [
    {
      sid       = "DocumentsAndExportsObjects"
      actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload"]
      resources = ["${module.bucket_documents.bucket_arn}/*", "${module.bucket_exports.bucket_arn}/*"]
    },
    {
      # Versions are listed so destruction past retention removes every stored version.
      sid       = "DocumentsAndExportsList"
      actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
      resources = [module.bucket_documents.bucket_arn, module.bucket_exports.bucket_arn]
    },
    {
      sid       = "AuditArchiveAppendOnly"
      actions   = ["s3:PutObject"]
      resources = ["${module.bucket_audit_archive.bucket_arn}/*"]
    },
    {
      sid       = "UseObjectKey"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [module.kms.key_arns["s3"]]
    },
    {
      sid       = "SendEmail"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = [module.ses.identity_arn, module.ses.configuration_set_arn]
    },
  ]

  sync_config_file = coalesce(var.sync_config_path, "${path.module}/../../../packages/sync/src/streams/sync-config.yaml")

  # PowerSync reads one YAML file (infra/powersync/powersync.yaml, shared with Docker Compose)
  # whose environment-specific values all come from PS_* variables set below.
  powersync_config_b64 = filebase64("${path.module}/../../powersync/powersync.yaml")
  sync_config_b64      = fileexists(local.sync_config_file) ? filebase64(local.sync_config_file) : base64encode("# sync config missing at plan time\n")
}

check "sync_config_present" {
  assert {
    condition     = fileexists(local.sync_config_file)
    error_message = "PowerSync sync config not found at ${local.sync_config_file}; the powersync task would start without sync streams."
  }
}

# ---------------------------------------------------------------------------------------------
# API (Hono)
# ---------------------------------------------------------------------------------------------

module "svc_api" {
  source = "../ecs_service"

  name             = "api"
  name_prefix      = local.name_prefix
  cluster          = local.cluster_name
  cluster_name     = local.cluster_name
  image            = local.images.api
  command          = var.api_command
  cpu              = local.sizes.api.cpu
  memory           = local.sizes.api.memory
  min_capacity     = local.sizes.api.min
  max_capacity     = local.sizes.api.max
  desired_count    = local.sizes.api.min
  cpu_architecture = var.cpu_architecture
  use_fargate_spot = var.use_fargate_spot
  container_port   = local.ports.api

  environment = merge(local.app_environment, {
    PORT = tostring(local.ports.api)
  })
  secrets             = local.app_secrets
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  egress_security_groups = {
    main_db = { security_group_id = module.db_main.security_group_id, port = 5432 }
  }

  load_balancer = {
    listener_arn      = module.alb.https_listener_arn
    security_group_id = module.alb.security_group_id
    host_headers      = [local.hosts.api]
    priority          = 10
    health_check_path = var.api_health_check_path
  }

  task_role_statements          = local.app_task_statements
  log_kms_key_arn               = module.kms.key_arns["logs"]
  log_retention_days            = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# Worker (pg-boss jobs: notifications, schedules, exports, integrations)
# ---------------------------------------------------------------------------------------------

module "svc_worker" {
  source = "../ecs_service"

  name             = "worker"
  name_prefix      = local.name_prefix
  cluster          = local.cluster_name
  cluster_name     = local.cluster_name
  image            = local.images.api
  command          = var.worker_command
  cpu              = local.sizes.worker.cpu
  memory           = local.sizes.worker.memory
  min_capacity     = local.sizes.worker.min
  max_capacity     = local.sizes.worker.max
  desired_count    = local.sizes.worker.min
  cpu_architecture = var.cpu_architecture
  use_fargate_spot = var.use_fargate_spot

  # Same bundle and configuration as the API.
  environment         = local.app_environment
  secrets             = local.app_secrets
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  egress_security_groups = {
    main_db = { security_group_id = module.db_main.security_group_id, port = 5432 }
  }

  task_role_statements          = local.app_task_statements
  log_kms_key_arn               = module.kms.key_arns["logs"]
  log_retention_days            = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# Database bootstrap and migrations: a task definition only, run on demand by the deploy
# workflow with `aws ecs run-task` before new application tasks start.
# ---------------------------------------------------------------------------------------------

module "task_migrate" {
  source = "../ecs_service"

  name             = "migrate"
  name_prefix      = local.name_prefix
  create_service   = false
  cluster          = local.cluster_name
  cluster_name     = local.cluster_name
  image            = local.images.api
  command          = var.migrate_command
  cpu              = local.sizes.migrate.cpu
  memory           = local.sizes.migrate.memory
  cpu_architecture = var.cpu_architecture

  # The RDS master password is managed (and rotated) by RDS and may contain characters that
  # are reserved in URLs, so the admin connection is passed as parts, not as a URL.
  environment = {
    NODE_ENV              = "production"
    HARBOUR_ENV           = var.environment
    APP_VERSION           = local.image_tags["api"]
    NODE_EXTRA_CA_CERTS   = var.rds_ca_bundle_path
    DATABASE_HOST         = module.db_main.address
    DATABASE_PORT         = tostring(module.db_main.port)
    DATABASE_NAME         = "harbour"
    DATABASE_SSL_MODE     = "verify-full"
    SYNC_STORAGE_HOST     = module.db_sync_storage.address
    SYNC_STORAGE_PORT     = tostring(module.db_sync_storage.port)
    SYNC_STORAGE_DATABASE = module.db_sync_storage.db_name
  }

  secrets = merge(
    {
      DATABASE_ADMIN_USER                   = "${module.db_main.master_user_secret_arn}:username::"
      DATABASE_ADMIN_PASSWORD               = "${module.db_main.master_user_secret_arn}:password::"
      DATABASE_OWNER_URL                    = "${local.secret_arns["db/harbour_owner"]}:url::"
      SYNC_STORAGE_ADMIN_USER               = "${module.db_sync_storage.master_user_secret_arn}:username::"
      SYNC_STORAGE_ADMIN_PASSWORD           = "${module.db_sync_storage.master_user_secret_arn}:password::"
      HARBOUR_DB_PASSWORD_POWERSYNC_STORAGE = "${local.secret_arns["db/powersync_storage"]}:password::"
    },
    { for r in local.db_login_roles : "HARBOUR_DB_PASSWORD_${upper(r)}" => "${local.secret_arns["db/${r}"]}:password::" },
  )
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  egress_security_groups = {
    main_db         = { security_group_id = module.db_main.security_group_id, port = 5432 }
    sync_storage_db = { security_group_id = module.db_sync_storage.security_group_id, port = 5432 }
  }

  log_kms_key_arn               = module.kms.key_arns["logs"]
  log_retention_days            = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# Web (Next.js). Reached only through CloudFront; never opens a database connection.
# ---------------------------------------------------------------------------------------------

module "svc_web" {
  source = "../ecs_service"

  name             = "web"
  name_prefix      = local.name_prefix
  cluster          = local.cluster_name
  cluster_name     = local.cluster_name
  image            = local.images.web
  cpu              = local.sizes.web.cpu
  memory           = local.sizes.web.memory
  min_capacity     = local.sizes.web.min
  max_capacity     = local.sizes.web.max
  desired_count    = local.sizes.web.min
  cpu_architecture = var.cpu_architecture
  use_fargate_spot = var.use_fargate_spot
  container_port   = local.ports.web
  writable_paths   = var.web_writable_paths

  environment = {
    NODE_ENV                = "production"
    HARBOUR_ENV             = var.environment
    PORT                    = tostring(local.ports.web)
    HOSTNAME                = "0.0.0.0"
    API_BASE_URL            = "https://${local.hosts.api}"
    PUBLIC_WEB_URL          = "https://${local.hosts.web}"
    TRUSTED_PROXY_CIDRS     = join(",", local.trusted_proxy_cidrs)
    NEXT_TELEMETRY_DISABLED = "1"
  }
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids

  load_balancer = {
    listener_arn          = module.alb.https_listener_arn
    security_group_id     = module.alb.security_group_id
    host_headers          = [local.hosts.web]
    priority              = 30
    health_check_path     = var.web_health_check_path
    required_header_name  = "X-Harbour-Origin-Verify"
    required_header_value = random_password.origin_verify.result
  }

  log_kms_key_arn               = module.kms.key_arns["logs"]
  log_retention_days            = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# PowerSync (self-hosted, unified API and replication process). Replicates from the main
# database as harbour_sync and keeps bucket data in the sync-storage database. Clients
# authenticate with JWTs the API signs; PowerSync verifies them against the API's JWKS.
# ---------------------------------------------------------------------------------------------

module "svc_powersync" {
  source = "../ecs_service"

  name             = "powersync"
  name_prefix      = local.name_prefix
  cluster          = local.cluster_name
  cluster_name     = local.cluster_name
  image            = local.images.powersync
  command          = ["start", "-r", "unified"]
  cpu              = local.sizes.powersync.cpu
  memory           = local.sizes.powersync.memory
  min_capacity     = local.sizes.powersync.min
  max_capacity     = local.sizes.powersync.max
  desired_count    = local.sizes.powersync.min
  cpu_architecture = var.cpu_architecture
  container_port   = local.ports.powersync

  environment = {
    POWERSYNC_CONFIG_B64      = local.powersync_config_b64
    POWERSYNC_SYNC_CONFIG_B64 = local.sync_config_b64
    NODE_OPTIONS              = "--max-old-space-size=${floor(local.sizes.powersync.memory * 0.8)}"
    PS_PORT                   = tostring(local.ports.powersync)
    PS_DATA_SOURCE_HOST       = module.db_main.address
    PS_DATA_SOURCE_PORT       = tostring(module.db_main.port)
    PS_DATA_SOURCE_DATABASE   = module.db_main.db_name
    PS_DATA_SOURCE_USER       = "harbour_sync"
    PS_DATA_SOURCE_SSLMODE    = "verify-full"
    PS_STORAGE_HOST           = module.db_sync_storage.address
    PS_STORAGE_PORT           = tostring(module.db_sync_storage.port)
    PS_STORAGE_DATABASE       = module.db_sync_storage.db_name
    PS_STORAGE_USER           = "powersync_storage"
    PS_STORAGE_SSLMODE        = "verify-full"
    PS_JWKS_URL               = "https://${local.hosts.api}/v1/sync/jwks"
    PS_JWT_AUDIENCE           = var.sync_jwt_audience
    PS_BLOCK_LOCAL_JWKS       = "true"
  }

  secrets = {
    PS_DATA_SOURCE_PASSWORD = "${local.secret_arns["db/harbour_sync"]}:password::"
    PS_STORAGE_PASSWORD     = "${local.secret_arns["db/powersync_storage"]}:password::"
    PS_API_TOKEN            = "${local.secret_arns["powersync/api-token"]}:token::"
  }
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  egress_security_groups = {
    main_db         = { security_group_id = module.db_main.security_group_id, port = 5432 }
    sync_storage_db = { security_group_id = module.db_sync_storage.security_group_id, port = 5432 }
  }

  load_balancer = {
    listener_arn      = module.alb.https_listener_arn
    security_group_id = module.alb.security_group_id
    host_headers      = [local.hosts.sync]
    priority          = 20
    health_check_path = "/probes/liveness"
  }

  log_kms_key_arn               = module.kms.key_arns["logs"]
  log_retention_days            = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# Flagsmith (optional placeholder, off by default). Its database lives on the sync-storage
# instance; feature flag state holds tenant identifiers only, never personal data.
# ---------------------------------------------------------------------------------------------

module "svc_flagsmith" {
  source = "../ecs_service"
  count  = var.enable_flagsmith ? 1 : 0

  name             = "flagsmith"
  name_prefix      = local.name_prefix
  cluster          = local.cluster_name
  cluster_name     = local.cluster_name
  image            = local.images.flagsmith
  cpu              = local.sizes.flagsmith.cpu
  memory           = local.sizes.flagsmith.memory
  min_capacity     = local.sizes.flagsmith.min
  max_capacity     = local.sizes.flagsmith.max
  desired_count    = local.sizes.flagsmith.min
  cpu_architecture = "X86_64"
  container_port   = local.ports.flagsmith

  environment = {
    DJANGO_ALLOWED_HOSTS              = local.hosts.flags
    DJANGO_DB_HOST                    = module.db_sync_storage.address
    DJANGO_DB_PORT                    = tostring(module.db_sync_storage.port)
    DJANGO_DB_NAME                    = "flagsmith"
    DJANGO_DB_USER                    = "flagsmith"
    ENVIRONMENT                       = "production"
    PREVENT_SIGNUP                    = "true"
    ENABLE_TELEMETRY                  = "false"
    ALLOW_REGISTRATION_WITHOUT_INVITE = "false"
  }

  secrets = {
    DJANGO_SECRET_KEY  = "${local.secret_arns["flagsmith"]}:django_secret_key::"
    DJANGO_DB_PASSWORD = "${local.secret_arns["flagsmith"]}:database_password::"
  }
  secrets_kms_key_arn = module.kms.key_arns["secrets"]

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  egress_security_groups = {
    sync_storage_db = { security_group_id = module.db_sync_storage.security_group_id, port = 5432 }
  }

  load_balancer = {
    listener_arn      = module.alb.https_listener_arn
    security_group_id = module.alb.security_group_id
    host_headers      = [local.hosts.flags]
    priority          = 40
    health_check_path = "/health/liveness/"
  }

  log_kms_key_arn               = module.kms.key_arns["logs"]
  log_retention_days            = var.log_retention_days
  log_group_deletion_protection = var.protect_log_groups
}

# ---------------------------------------------------------------------------------------------
# Secrets
#
# Terraform creates the secret containers only. Values are generated inside AWS by
# infra/scripts/seed-secrets.sh (once per environment) so that no password ever appears in
# Terraform state or plan output, and the plan role never needs secretsmanager:GetSecretValue.
# ---------------------------------------------------------------------------------------------

locals {
  # Login roles on the main database, created by `pnpm db:bootstrap` (packages/db, ADR-0002).
  db_login_roles = ["harbour_owner", "harbour_app", "harbour_auth", "harbour_sync", "harbour_operator", "harbour_worker"]

  secret_definitions = merge(
    { for r in local.db_login_roles : "db/${r}" => "username, password and url of the ${r} role on the main database" },
    {
      "db/powersync_storage" = "username, password and url of the powersync_storage role on the bucket-storage database"
      "api"                  = "API runtime secrets: Better Auth secret and the PowerSync JWT signing key and key ID"
      "powersync/api-token"  = "Token for the PowerSync admin API"
    },
    var.enable_flagsmith ? { "flagsmith" = "Flagsmith Django secret key and database password" } : {},
  )

  secret_arns = { for k, v in aws_secretsmanager_secret.this : k => v.arn }
}

resource "aws_secretsmanager_secret" "this" {
  #checkov:skip=CKV2_AWS_57:Rotation is yearly and scripted (infra/scripts/seed-secrets.sh --rotate, section 5.3); RDS master credentials rotate automatically.
  for_each = local.secret_definitions

  name                    = "${local.name_prefix}/${each.key}"
  description             = each.value
  kms_key_id              = module.kms.key_arns["secrets"]
  recovery_window_in_days = var.environment == "prod" ? 30 : 7
}

# ---------------------------------------------------------------------------------------------
# Databases
# ---------------------------------------------------------------------------------------------

module "db_main" {
  source = "../rds_postgres"

  identifier            = "${local.name_prefix}-main"
  instance_class        = var.main_db_instance_class
  allocated_storage     = var.main_db_allocated_storage
  max_allocated_storage = var.main_db_max_allocated_storage
  multi_az              = var.main_db_multi_az
  db_name               = "harbour"
  master_username       = "harbour_admin"

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.data_subnet_ids
  allowed_security_group_ids = {
    api       = module.svc_api.security_group_id
    worker    = module.svc_worker.security_group_id
    migrate   = module.task_migrate.security_group_id
    powersync = module.svc_powersync.security_group_id
  }

  kms_key_arn         = module.kms.key_arns["rds"]
  secrets_kms_key_arn = module.kms.key_arns["secrets"]
  logs_kms_key_arn    = module.kms.key_arns["logs"]
  log_retention_days  = var.log_retention_days

  # PowerSync streams changes from this database.
  logical_replication = true

  deletion_protection                 = var.db_deletion_protection
  skip_final_snapshot                 = var.db_skip_final_snapshot
  performance_insights_retention_days = var.db_performance_insights_retention_days
}

# PowerSync bucket storage: holds per-bucket copies of synced rows, so it is personal data and
# gets the same hardening. It can be rebuilt from the main database by a PowerSync resync.
module "db_sync_storage" {
  source = "../rds_postgres"

  identifier            = "${local.name_prefix}-sync-storage"
  instance_class        = var.sync_storage_db_instance_class
  allocated_storage     = var.sync_storage_db_allocated_storage
  max_allocated_storage = var.sync_storage_db_allocated_storage * 4
  multi_az              = var.sync_storage_db_multi_az
  db_name               = "powersync_storage"
  master_username       = "powersync_admin"

  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.data_subnet_ids
  allowed_security_group_ids = merge(
    {
      powersync = module.svc_powersync.security_group_id
      migrate   = module.task_migrate.security_group_id
    },
    var.enable_flagsmith ? { flagsmith = module.svc_flagsmith[0].security_group_id } : {},
  )

  kms_key_arn         = module.kms.key_arns["rds"]
  secrets_kms_key_arn = module.kms.key_arns["secrets"]
  logs_kms_key_arn    = module.kms.key_arns["logs"]
  log_retention_days  = var.log_retention_days

  deletion_protection                 = var.db_deletion_protection
  skip_final_snapshot                 = var.db_skip_final_snapshot
  performance_insights_retention_days = var.db_performance_insights_retention_days
}

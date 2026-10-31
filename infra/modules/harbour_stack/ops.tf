# ---------------------------------------------------------------------------------------------
# Logs, alerts and cost
# ---------------------------------------------------------------------------------------------

module "observability" {
  source = "../observability"

  project_id                  = var.project_id
  region                      = var.region
  name_prefix                 = local.name_prefix
  alert_email_addresses       = var.alert_email_addresses
  security_log_retention_days = var.security_log_retention_days
  app_log_retention_days      = var.app_log_retention_days
  lock_security_logs          = local.lock_security_logs
  worker_service_name         = module.svc_worker.name
  api_service_name            = module.svc_api.name
  always_on_services          = [module.svc_worker.name, module.svc_powersync.name]

  kms_key_id = module.kms.key_ids["logs"]

  sql_instances = {
    main         = module.db_main.instance_name
    sync_storage = module.db_sync_storage.instance_name
  }

  depends_on = [terraform_data.locks_only_in_prod, module.kms]
}

module "budget" {
  source = "../budget"

  billing_account_id       = var.billing_account_id
  project_number           = module.project.project_number
  name                     = "${local.name_prefix}-monthly"
  monthly_limit            = var.budget_monthly_limit
  notification_channel_ids = module.observability.notification_channel_ids
}

# ---------------------------------------------------------------------------------------------
# Releases: the GitHub release account (infra/bootstrap) pushes images and acts as the runtime
# accounts it releases, and nothing else
# ---------------------------------------------------------------------------------------------

resource "google_artifact_registry_repository_iam_member" "release_push" {
  count = var.release_service_account == null ? 0 : 1

  project    = var.project_id
  location   = var.region
  repository = "harbour"
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${var.release_service_account}"

  depends_on = [module.registry]
}

resource "google_service_account_iam_member" "release_acts_as" {
  for_each = var.release_service_account == null ? {} : {
    api       = module.svc_api.service_account_email
    worker    = module.svc_worker.service_account_email
    web       = module.svc_web.service_account_email
    migrate   = module.job_migrate.service_account_email
    powersync = module.svc_powersync.service_account_email
  }

  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.release_service_account}"
}

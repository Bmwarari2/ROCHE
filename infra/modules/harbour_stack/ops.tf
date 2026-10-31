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

  sql_instances = {
    main         = module.db_main.instance_name
    sync_storage = module.db_sync_storage.instance_name
  }

  depends_on = [terraform_data.locks_only_in_prod]
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
# GitHub Actions: Workload Identity Federation, this repository only, no keys
# ---------------------------------------------------------------------------------------------

module "github_wif" {
  source = "../github_wif"

  project_id        = var.project_id
  name_prefix       = local.name_prefix
  github_repository = var.github_repository
  state_bucket_name = var.state_bucket_name
}

# Deploys push images and run the migration job.
resource "google_artifact_registry_repository_iam_member" "deploy_push" {
  project    = var.project_id
  location   = var.region
  repository = "harbour"
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${module.github_wif.deploy_service_account}"

  depends_on = [module.registry]
}

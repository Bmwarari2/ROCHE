# ---------------------------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------------------------

module "ses" {
  source = "../ses"

  domain                 = var.domain_name
  configuration_set_name = local.name_prefix
  route53_zone_id        = var.route53_zone_id
}

# ---------------------------------------------------------------------------------------------
# Alarms and cost
# ---------------------------------------------------------------------------------------------

module "observability" {
  source = "../observability"

  name_prefix           = local.name_prefix
  alerts_kms_key_arn    = module.kms.key_arns["alerts"]
  alert_email_addresses = var.alert_email_addresses
  alb_arn_suffix        = module.alb.arn_suffix
  ecs_cluster_name      = local.cluster_name

  target_group_arn_suffixes = merge(
    {
      api       = module.svc_api.target_group_arn_suffix
      web       = module.svc_web.target_group_arn_suffix
      powersync = module.svc_powersync.target_group_arn_suffix
    },
    var.enable_flagsmith ? { flagsmith = module.svc_flagsmith[0].target_group_arn_suffix } : {},
  )

  ecs_services = merge(
    {
      api       = { min_running_tasks = local.sizes.api.min }
      worker    = { min_running_tasks = local.sizes.worker.min }
      web       = { min_running_tasks = local.sizes.web.min }
      powersync = { min_running_tasks = local.sizes.powersync.min }
    },
    var.enable_flagsmith ? { flagsmith = { min_running_tasks = local.sizes.flagsmith.min } } : {},
  )

  rds_instances = {
    main         = { identifier = module.db_main.instance_id, logical_replication = true }
    sync_storage = { identifier = module.db_sync_storage.instance_id }
  }
}

module "budget" {
  source = "../budget"

  name            = "${local.name_prefix}-monthly"
  monthly_limit   = var.budget_monthly_limit
  sns_topic_arn   = module.observability.alerts_topic_arn
  email_addresses = var.budget_email_addresses
}

# ---------------------------------------------------------------------------------------------
# GitHub Actions OIDC roles
# ---------------------------------------------------------------------------------------------

module "github_oidc" {
  source = "../github_oidc"

  name_prefix           = local.name_prefix
  github_repository     = var.github_repository
  create_oidc_provider  = var.create_github_oidc_provider
  state_bucket_name     = var.state_bucket_name
  state_kms_key_arn     = var.state_kms_key_arn
  state_lock_table_name = var.state_lock_table_name
  region                = local.region
}

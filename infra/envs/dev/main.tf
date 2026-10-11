# Harbour dev environment (AWS dev account, eu-west-2). Deployed from every merge to main.
# Holds synthetic seed data only, so it trades resilience for cost: single NAT gateway,
# single-AZ databases, interface endpoints in one zone and Fargate Spot.

module "stack" {
  source = "../../modules/harbour_stack"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment     = var.environment
  domain_name     = var.domain_name
  route53_zone_id = var.route53_zone_id

  github_repository           = var.github_repository
  create_github_oidc_provider = var.create_github_oidc_provider
  state_bucket_name           = var.state_bucket_name
  state_kms_key_arn           = var.state_kms_key_arn
  state_lock_table_name       = var.state_lock_table_name

  vpc_cidr_block              = "10.40.0.0/16"
  nat_gateway_per_az          = false
  interface_endpoint_az_count = 1

  main_db_instance_class         = "db.t4g.medium"
  main_db_multi_az               = false
  sync_storage_db_instance_class = "db.t4g.medium"
  sync_storage_db_multi_az       = false
  db_deletion_protection         = false
  db_skip_final_snapshot         = false

  image_tags       = var.image_tags
  enable_flagsmith = var.enable_flagsmith
  use_fargate_spot = true

  # Pinned AWS managed rule group versions; required in prod (human action H-140).
  waf_managed_rule_group_versions = var.waf_managed_rule_group_versions

  alb_deletion_protection = false
  force_destroy_buckets   = true
  log_retention_days      = 365
  protect_log_groups      = false
  audit_archive_lock_mode = "GOVERNANCE"
  audit_archive_lock_days = 7

  alert_email_addresses  = var.alert_email_addresses
  budget_monthly_limit   = var.budget_monthly_limit
  budget_email_addresses = var.budget_email_addresses
}

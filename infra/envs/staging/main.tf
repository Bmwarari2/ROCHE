# Harbour staging environment (AWS staging account, eu-west-2). Deployed on tagged release
# candidates with an anonymised production-like dataset, so it mirrors prod's resilience
# settings where they affect behaviour (Multi-AZ main database, deletion protection) and
# saves cost where they do not (single NAT gateway, smaller instances).

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

  vpc_cidr_block              = "10.41.0.0/16"
  nat_gateway_per_az          = false
  interface_endpoint_az_count = 2

  main_db_instance_class         = "db.t4g.large"
  main_db_multi_az               = true
  sync_storage_db_instance_class = "db.t4g.medium"
  sync_storage_db_multi_az       = false
  db_deletion_protection         = true
  db_skip_final_snapshot         = false

  image_tags       = var.image_tags
  enable_flagsmith = var.enable_flagsmith
  use_fargate_spot = false

  alb_deletion_protection = true
  force_destroy_buckets   = false
  log_retention_days      = 365
  protect_log_groups      = true
  audit_archive_lock_mode = "GOVERNANCE"
  audit_archive_lock_days = 30

  alert_email_addresses  = var.alert_email_addresses
  budget_monthly_limit   = var.budget_monthly_limit
  budget_email_addresses = var.budget_email_addresses
}

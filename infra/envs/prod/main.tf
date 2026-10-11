# Harbour production (AWS prod account, eu-west-2). Applied on signed tags after Brian's
# manual approval. Disaster recovery is Multi-AZ plus 35 days of point-in-time recovery
# (RPO 15 minutes, RTO 4 hours); AWS has no second UK region (ADR-0001).

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

  vpc_cidr_block              = "10.42.0.0/16"
  nat_gateway_per_az          = true
  interface_endpoint_az_count = 3

  main_db_instance_class            = "db.r7g.large"
  main_db_allocated_storage         = 200
  main_db_max_allocated_storage     = 1000
  main_db_multi_az                  = true
  sync_storage_db_instance_class    = "db.r7g.large"
  sync_storage_db_allocated_storage = 100
  sync_storage_db_multi_az          = true
  db_deletion_protection            = true
  db_skip_final_snapshot            = false

  image_tags       = var.image_tags
  enable_flagsmith = var.enable_flagsmith
  use_fargate_spot = false

  service_sizes = {
    api       = { cpu = 1024, memory = 2048, min = 2, max = 10 }
    worker    = { cpu = 1024, memory = 2048, min = 2, max = 6 }
    web       = { cpu = 1024, memory = 2048, min = 2, max = 10 }
    powersync = { cpu = 2048, memory = 4096, min = 1, max = 1 }
  }

  alb_deletion_protection = true
  force_destroy_buckets   = false
  log_retention_days      = 400
  protect_log_groups      = true

  # COMPLIANCE mode cannot be shortened or removed by anyone, including the root user, for
  # the retention period. Confirm the period in an ADR before the first prod apply.
  audit_archive_lock_mode = "COMPLIANCE"
  audit_archive_lock_days = 365

  alert_email_addresses  = var.alert_email_addresses
  budget_monthly_limit   = var.budget_monthly_limit
  budget_email_addresses = var.budget_email_addresses
}

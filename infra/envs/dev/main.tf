# Harbour dev environment (its own Google Cloud project, europe-west2). Deployed from every merge
# to main. Holds synthetic seed data only, so it trades resilience for cost: zonal databases,
# small tiers and buckets that terraform destroy may empty.

module "stack" {
  source = "../../modules/harbour_stack"

  project_id      = var.project_id
  environment     = var.environment
  domain_name     = var.domain_name
  dns_zone_name   = var.dns_zone_name
  create_dns_zone = var.create_dns_zone

  safety_case_version = var.safety_case_version

  release_service_account = var.release_service_account

  subnet_cidr = "10.40.0.0/20"

  main_db_tier           = "db-custom-1-3840"
  sync_storage_db_tier   = "db-custom-1-3840"
  db_high_availability   = false
  db_deletion_protection = false

  deletion_protection   = false
  force_destroy_buckets = true

  # Retention locks are prod only; dev keeps a week of audit archive retention, unlocked.
  audit_archive_retention_days = 7
  security_log_retention_days  = 400

  service_sizes = {
    api       = { cpu = "1", memory = "1Gi", min = 0, max = 2 }
    worker    = { cpu = "1", memory = "1Gi", min = 1, max = 1 }
    web       = { cpu = "1", memory = "1Gi", min = 0, max = 2 }
    powersync = { cpu = "1", memory = "2Gi", min = 1, max = 1 }
  }

  armor_rule_versions = var.armor_rule_versions

  enable_flagsmith = var.enable_flagsmith
  smtp             = var.smtp

  alert_email_addresses = var.alert_email_addresses
  billing_account_id    = var.billing_account_id
  budget_monthly_limit  = var.budget_monthly_limit
}

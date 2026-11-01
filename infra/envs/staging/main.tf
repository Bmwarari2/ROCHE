# Harbour staging (its own Google Cloud project, europe-west2): a faithful rehearsal of prod at a
# smaller size. Regional main database, deletion protection on, retention not locked.

module "stack" {
  source = "../../modules/harbour_stack"

  project_id      = var.project_id
  environment     = var.environment
  domain_name     = var.domain_name
  dns_zone_name   = var.dns_zone_name
  create_dns_zone = var.create_dns_zone

  safety_case_version = var.safety_case_version

  release_service_account = var.release_service_account

  subnet_cidr = "10.41.0.0/20"

  main_db_tier           = "db-custom-2-7680"
  sync_storage_db_tier   = "db-custom-1-3840"
  db_high_availability   = true
  db_deletion_protection = true

  deletion_protection   = true
  force_destroy_buckets = false

  audit_archive_retention_days = 30
  security_log_retention_days  = 400

  armor_rule_versions = var.armor_rule_versions

  enable_flagsmith = var.enable_flagsmith
  smtp             = var.smtp

  alert_email_addresses = var.alert_email_addresses
  billing_account_id    = var.billing_account_id
  budget_monthly_limit  = var.budget_monthly_limit
}

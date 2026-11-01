# Harbour production (its own Google Cloud project, europe-west2). Applied on signed tags after
# Brian's manual approval. Disaster recovery is regional high availability plus point-in-time
# recovery (RPO 15 minutes, RTO 4 hours; ADR-0098). The audit archive and security logs are
# locked: a lock can never be shortened or removed, so confirm the periods before the first apply.

module "stack" {
  source = "../../modules/harbour_stack"

  project_id      = var.project_id
  environment     = var.environment
  domain_name     = var.domain_name
  dns_zone_name   = var.dns_zone_name
  create_dns_zone = var.create_dns_zone

  # The e-learning content origin's own registrable domain (ADR-0093, security review H1).
  elearning_domain_name   = var.elearning_domain_name
  elearning_dns_zone_name = var.elearning_dns_zone_name

  safety_case_version = var.safety_case_version

  release_service_account = var.release_service_account

  subnet_cidr = "10.42.0.0/20"

  main_db_tier            = "db-custom-4-16384"
  sync_storage_db_tier    = "db-custom-2-8192"
  main_db_disk_gb         = 200
  sync_storage_db_disk_gb = 100
  db_edition              = "ENTERPRISE_PLUS"
  db_pitr_days            = 35
  db_high_availability    = true
  db_deletion_protection  = true

  deletion_protection   = true
  force_destroy_buckets = false

  audit_archive_retention_days = 365
  lock_audit_archive           = true
  security_log_retention_days  = 400
  lock_security_logs           = true

  # Pinned Cloud Armor preconfigured rule versions; required in prod (human action H-140).
  armor_rule_versions = var.armor_rule_versions

  service_sizes = {
    api       = { cpu = "2", memory = "2Gi", min = 2, max = 10 }
    worker    = { cpu = "2", memory = "2Gi", min = 2, max = 6 }
    web       = { cpu = "2", memory = "2Gi", min = 2, max = 10 }
    powersync = { cpu = "2", memory = "4Gi", min = 1, max = 1 }
  }

  enable_flagsmith = var.enable_flagsmith
  smtp             = var.smtp

  alert_email_addresses = var.alert_email_addresses
  billing_account_id    = var.billing_account_id
  budget_monthly_limit  = var.budget_monthly_limit
}

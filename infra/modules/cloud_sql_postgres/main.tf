# PostgreSQL 17 on Cloud SQL in London: private IP only, encrypted connections only, the data
# disk and backups under the project's key, regional high availability, automated backups held in
# europe-west2 with point-in-time recovery, and pgAudit on (section 5.5). Roles and passwords are
# created by `pnpm db:bootstrap` (packages/db, ADR-0002), never by Terraform, so no password is
# ever in state.

locals {
  flags = merge(
    {
      "cloudsql.enable_pgaudit" = "on"
      "pgaudit.log"             = "ddl,role,write"
      "pgaudit.log_parameter"   = "off"
      "pgaudit.log_relation"    = "on"
      "pgaudit.log_catalog"     = "off"
      # Error lines name the statement, never the values (a duplicate key's DETAIL would).
      "log_error_verbosity"        = "terse"
      "log_checkpoints"            = "on"
      "log_connections"            = "on"
      "log_disconnections"         = "on"
      "log_lock_waits"             = "on"
      "log_min_messages"           = "warning"
      "log_min_error_statement"    = "error"
      "log_temp_files"             = "0"
      "log_min_duration_statement" = "-1"
    },
    var.logical_decoding ? { "cloudsql.logical_decoding" = "on" } : {},
  )
}

resource "google_sql_database_instance" "this" {
  project             = var.project_id
  name                = var.name
  region              = var.region
  database_version    = "POSTGRES_17"
  encryption_key_name = var.kms_key_id
  deletion_protection = var.deletion_protection

  settings {
    tier                        = var.tier
    edition                     = var.edition
    availability_type           = var.high_availability ? "REGIONAL" : "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.disk_size_gb
    disk_autoresize             = true
    disk_autoresize_limit       = var.disk_autoresize_limit_gb
    deletion_protection_enabled = var.deletion_protection
    user_labels                 = var.labels

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = var.network_id
      ssl_mode                                      = "ENCRYPTED_ONLY"
      enable_private_path_for_google_cloud_services = false
    }

    backup_configuration {
      enabled                        = true
      location                       = var.region
      start_time                     = "02:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    maintenance_window {
      day          = 7
      hour         = 3
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = var.query_insights
      record_application_tags = false
      record_client_address   = false
    }

    password_validation_policy {
      enable_password_policy      = true
      min_length                  = 16
      complexity                  = "COMPLEXITY_DEFAULT"
      disallow_username_substring = true
    }

    dynamic "database_flags" {
      for_each = local.flags

      content {
        name  = database_flags.key
        value = database_flags.value
      }
    }
  }

  depends_on = [var.private_services_connection]

  lifecycle {
    precondition {
      condition     = var.edition == "ENTERPRISE_PLUS" || var.transaction_log_retention_days <= 7
      error_message = "ENTERPRISE keeps at most 7 days of transaction logs; use ENTERPRISE_PLUS for a longer point-in-time recovery window."
    }
  }
}

resource "google_sql_database" "this" {
  project  = var.project_id
  name     = var.database_name
  instance = google_sql_database_instance.this.name
}

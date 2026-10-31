# The project's baseline: the APIs Harbour uses and audit logs that include Data Access (section
# 5.5). The organisation policies (resources in London only, no service account keys) and the
# GitHub federation are applied by a person in infra/bootstrap, never by CI.

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_service" "this" {
  for_each = var.services

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# Admin Activity is always on; Data Access (reads and writes of data and metadata) is turned on
# for every service, so reads of secrets, buckets and the database configuration are recorded.
resource "google_project_iam_audit_config" "all_services" {
  project = var.project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }

  audit_log_config {
    log_type = "DATA_READ"
  }

  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# Service agents that encrypt with the project's keys (CMEK). Created now so their keys can be
# granted before the resources that use them.
resource "google_project_service_identity" "agents" {
  provider = google-beta
  for_each = toset(["secretmanager.googleapis.com", "sqladmin.googleapis.com", "artifactregistry.googleapis.com"])

  project = var.project_id
  service = each.key

  depends_on = [google_project_service.this]
}

# Cloud Logging's service account for this project, which encrypts the log buckets with the
# project's key (CMEK).
data "google_logging_project_cmek_settings" "this" {
  project = var.project_id

  depends_on = [google_project_service.this]
}

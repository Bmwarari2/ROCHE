# The project's baseline: the APIs Harbour uses and the service agents that encrypt with its keys.
# Project IAM (the Data Access audit configuration), the organisation policies (resources in
# London only, no service account keys) and the GitHub federation are applied by a person in
# infra/bootstrap, never by CI.

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_service" "this" {
  for_each = var.services

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
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

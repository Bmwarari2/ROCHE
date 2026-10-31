# The project's baseline: the APIs Harbour uses, an organisation policy that refuses resources
# outside London, no service account keys, and audit logs that include Data Access (section 5.5).

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_service" "this" {
  for_each = var.services

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}

# Personal data stays in the UK: nothing that stores data can be created outside europe-west2.
resource "google_org_policy_policy" "resource_locations" {
  count = var.enforce_resource_locations ? 1 : 0

  name   = "projects/${var.project_id}/policies/gcp.resourceLocations"
  parent = "projects/${var.project_id}"

  spec {
    rules {
      values {
        allowed_values = var.allowed_locations
      }
    }
  }

  depends_on = [google_project_service.this]
}

# GitHub Actions and people sign in through Workload Identity Federation and their own accounts:
# no long-lived JSON keys anywhere.
resource "google_org_policy_policy" "no_service_account_keys" {
  count = var.enforce_resource_locations ? 1 : 0

  name   = "projects/${var.project_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${var.project_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }

  depends_on = [google_project_service.this]
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

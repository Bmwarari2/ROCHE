# What CI must never be able to change, applied once per environment by a person with
# organisation policy, IAM and deny policy rights (infra/README.md, Bootstrap):
#
# - project IAM: the Data Access audit configuration (CI holds no project IAM role);
# - the organisation policies that keep data resources in London and forbid service account keys;
# - the folder's log storage in London with no _Default sink, for projects created after it;
# - Workload Identity Federation for GitHub Actions, its plan, apply and release accounts, and the
#   deny policy that keeps all three away from secret values, data and logs.

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
}

resource "google_org_policy_policy" "no_service_account_keys" {
  count = var.block_service_account_keys ? 1 : 0

  name   = "projects/${var.project_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${var.project_id}"

  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# Logs of projects in the folder are stored in London, and their _Default sink is not created
# (Harbour's own sinks route logs to its London buckets). Applies to projects created afterwards.
resource "google_logging_folder_settings" "london" {
  count = var.folder_id == null ? 0 : 1

  folder               = var.folder_id
  storage_location     = "europe-west2"
  disable_default_sink = true
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

module "github_wif" {
  source = "../modules/github_wif"

  project_id                 = var.project_id
  environment                = var.environment
  github_repository          = var.github_repository
  github_repository_id       = var.github_repository_id
  github_repository_owner_id = var.github_repository_owner_id
  state_bucket_name          = var.state_bucket_name
}

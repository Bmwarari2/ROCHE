# What CI must never be able to change, applied once per environment by a person with
# organisation policy, IAM and deny policy rights (infra/README.md, Bootstrap):
#
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

module "github_wif" {
  source = "../modules/github_wif"

  project_id                 = var.project_id
  environment                = var.environment
  github_repository          = var.github_repository
  github_repository_id       = var.github_repository_id
  github_repository_owner_id = var.github_repository_owner_id
  state_bucket_name          = var.state_bucket_name
}

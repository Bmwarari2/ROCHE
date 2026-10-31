# One Docker repository in London for the api, web, powersync-service, flagsmith and clamav
# images. Tags are immutable, so a released tag always names the same image.

resource "google_artifact_registry_repository" "this" {
  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  kms_key_name  = var.kms_key_id
  description   = "Harbour container images"

  docker_config {
    immutable_tags = true
  }

  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"

    condition {
      tag_state  = "UNTAGGED"
      older_than = "${var.untagged_retention_days * 86400}s"
    }
  }
}

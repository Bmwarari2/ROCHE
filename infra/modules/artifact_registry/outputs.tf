output "repository_url" {
  description = "Prefix for image names, for example europe-west2-docker.pkg.dev/<project>/harbour."
  value       = "${google_artifact_registry_repository.this.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.this.repository_id}"
}

output "repository_id" {
  value = google_artifact_registry_repository.this.id
}

output "location" {
  value = google_artifact_registry_repository.this.location
}

output "name" {
  value = var.name
}

output "service_account_email" {
  value = google_service_account.this.email
}

output "service_account_member" {
  value = "serviceAccount:${google_service_account.this.email}"
}

output "service_name" {
  description = "The Cloud Run service name (null for a job)."
  value       = one(google_cloud_run_v2_service.this[*].name)
}

output "uri" {
  value = one(google_cloud_run_v2_service.this[*].uri)
}

output "ingress" {
  value = one(google_cloud_run_v2_service.this[*].ingress)
}

output "location" {
  value = var.region
}

output "min_instances" {
  value = var.min_instances
}

output "sidecar_names" {
  value = [for s in var.sidecars : s.name]
}

output "secret_ids" {
  description = "Secrets this service may read."
  value       = sort(tolist(local.secret_ids))
}

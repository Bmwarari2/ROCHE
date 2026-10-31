output "project_number" {
  description = "The project number."
  value       = data.google_project.this.number
}

output "service_agents" {
  description = "Service agent emails that need the project's encryption keys, by purpose."
  value = {
    secrets   = google_project_service_identity.agents["secretmanager.googleapis.com"].email
    sql       = google_project_service_identity.agents["sqladmin.googleapis.com"].email
    artifacts = google_project_service_identity.agents["artifactregistry.googleapis.com"].email
    storage   = "service-${data.google_project.this.number}@gs-project-accounts.iam.gserviceaccount.com"
  }
}

output "allowed_locations" {
  description = "The gcp.resourceLocations values set on the project."
  value       = var.allowed_locations
}

output "audit_log_types" {
  description = "Audit log types turned on for every service."
  value       = [for c in google_project_iam_audit_config.all_services.audit_log_config : c.log_type]
}

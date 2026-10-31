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
    logs      = data.google_logging_project_cmek_settings.this.service_account_id
  }
}


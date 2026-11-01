output "secret_ids" {
  description = "Full resource ids, by short name."
  value       = { for k, v in google_secret_manager_regional_secret.this : k => v.id }
}

output "secret_names" {
  description = "Secret ids (the last path segment), by short name."
  value       = { for k, v in google_secret_manager_regional_secret.this : k => v.secret_id }
}

output "locations" {
  value = { for k, v in google_secret_manager_regional_secret.this : k => v.location }
}

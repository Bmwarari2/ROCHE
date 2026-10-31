output "name" {
  value = google_storage_bucket.this.name
}

output "url" {
  value = google_storage_bucket.this.url
}

output "location" {
  value = google_storage_bucket.this.location
}

output "public_access_prevention" {
  value = google_storage_bucket.this.public_access_prevention
}

output "uniform_bucket_level_access" {
  value = google_storage_bucket.this.uniform_bucket_level_access
}

output "retention_locked" {
  description = "Whether the retention policy is locked."
  value       = var.retention_days != null && var.lock_retention_policy
}

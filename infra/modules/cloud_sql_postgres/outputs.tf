output "instance_name" {
  value = google_sql_database_instance.this.name
}

output "connection_name" {
  value = google_sql_database_instance.this.connection_name
}

output "private_ip" {
  value = google_sql_database_instance.this.private_ip_address
}

output "database_name" {
  value = google_sql_database.this.name
}

output "region" {
  value = google_sql_database_instance.this.region
}

output "public_ip_enabled" {
  description = "Always false: the instance has a private IP only."
  value       = one(google_sql_database_instance.this.settings[0].ip_configuration[*].ipv4_enabled)
}

output "availability_type" {
  value = google_sql_database_instance.this.settings[0].availability_type
}

output "flags" {
  description = "Database flags, by name."
  value       = local.flags
}

output "backup_location" {
  value = one(google_sql_database_instance.this.settings[0].backup_configuration[*].location)
}

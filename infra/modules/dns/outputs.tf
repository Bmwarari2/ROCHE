output "manual_records" {
  description = "Records to create by hand when the zone is not in this project (null otherwise)."
  value       = var.manage_zone ? null : local.records
}

output "name_servers" {
  value = var.manage_zone && var.create_zone ? google_dns_managed_zone.this[0].name_servers : []
}

output "managed_record_keys" {
  description = "Records created in Cloud DNS, by key."
  value       = sort(keys(google_dns_record_set.this))
}

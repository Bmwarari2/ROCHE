output "ip_address" {
  value = google_compute_global_address.this.address
}

output "hosts" {
  value = local.hosts
}

output "dns_authorization_record" {
  description = "The CNAME record Certificate Manager needs to issue the certificate."
  value       = google_certificate_manager_dns_authorization.this.dns_resource_record
}

output "security_policy_id" {
  value = google_compute_security_policy.this.id
}

output "armor_expressions" {
  description = "Preconfigured rule expressions, by rule name."
  value       = { for r in var.armor_rules : r => "evaluatePreconfiguredWaf('${r}-${local.pinned_version[r]}', {'sensitivity': ${var.armor_sensitivity}})" }
}

output "unpinned_rules" {
  value = local.unpinned_rules
}

output "cdn_backends" {
  description = "Backends with Cloud CDN on."
  value       = [for k, v in google_compute_backend_service.this : k if v.enable_cdn]
}

output "min_tls_version" {
  value = google_compute_ssl_policy.this.min_tls_version
}

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
  description = "Backends with Cloud CDN on, and the paths they serve."
  value = concat(
    [for k, v in google_compute_backend_service.this : k if v.enable_cdn],
    [for b in google_compute_backend_service.static : "${var.cdn_host}-static"],
  )
}

output "cdn_paths" {
  value = var.cdn_host == null ? [] : var.cdn_paths
}

output "rule_expressions" {
  description = "Every Cloud Armor rule expression, by priority."
  value = {
    for r in google_compute_security_policy.this.rule :
    tostring(r.priority) => try(r.match[0].expr[0].expression, null)
  }
}

output "min_tls_version" {
  value = google_compute_ssl_policy.this.min_tls_version
}

output "allowlisted_hosts" {
  description = "Hosts reached only from their allowlist."
  value       = sort(keys(var.allowlisted_hosts))
}

# Cloud DNS for the environment's domain: the hosts point at the load balancer and Certificate
# Manager's authorisation record lets it issue and renew the certificate. Without a zone here the
# same records are listed for whoever runs the domain's DNS.

resource "google_dns_managed_zone" "this" {
  count = var.manage_zone && var.create_zone ? 1 : 0

  project     = var.project_id
  name        = var.zone_name
  dns_name    = "${var.domain_name}."
  description = "Harbour ${var.domain_name}"
  visibility  = "public"

  dnssec_config {
    state = "on"

    default_key_specs {
      algorithm  = "rsasha256"
      key_length = 2048
      key_type   = "keySigning"
    }

    default_key_specs {
      algorithm  = "rsasha256"
      key_length = 1024
      key_type   = "zoneSigning"
    }
  }
}

locals {
  zone = var.manage_zone ? (var.create_zone ? google_dns_managed_zone.this[0].name : var.zone_name) : null

  records = merge(
    { for k, host in var.hosts : k => { name = "${host}.", type = "A", data = var.ip_address } },
    # One authorisation record, keyed by a known name so the plan can count it.
    { cert = { name = try(var.dns_authorization_record[0].name, null), type = "CNAME", data = try(var.dns_authorization_record[0].data, null) } },
  )
}

resource "google_dns_record_set" "this" {
  for_each = var.manage_zone ? local.records : {}

  project      = var.project_id
  managed_zone = local.zone
  name         = each.value.name
  type         = each.value.type
  ttl          = 300
  rrdatas      = [each.value.data]
}

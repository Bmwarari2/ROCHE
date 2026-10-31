# ---------------------------------------------------------------------------------------------
# Load balancer, Cloud Armor and Cloud CDN
# ---------------------------------------------------------------------------------------------

locals {
  lb_backends = merge(
    {
      app  = module.svc_web.service_name
      api  = module.svc_api.service_name
      sync = module.svc_powersync.service_name
    },
    var.enable_flagsmith ? { flags = module.svc_flagsmith[0].service_name } : {},
  )
}

module "load_balancer" {
  source = "../load_balancer"

  project_id            = var.project_id
  region                = var.region
  name_prefix           = local.name_prefix
  domain_name           = var.domain_name
  backends              = local.lb_backends
  default_host          = "app"
  cdn_host              = "app"
  armor_rule_versions   = var.armor_rule_versions
  rate_limit_per_minute = var.armor_rate_limit_per_minute

  # Server-rendered pages reach the API from the NAT addresses: not one rate-limited client.
  trusted_source_ranges = [for ip in module.network.nat_addresses : "${ip}/32"]
  restricted_paths      = { sync = ["/api/admin"] }
  allowlisted_hosts = var.enable_flagsmith ? {
    flags = concat([for ip in module.network.nat_addresses : "${ip}/32"], var.flags_admin_ranges)
  } : {}
}

# Prod pins every Cloud Armor preconfigured rule (OWASP CRS) to a version, so a rule set never
# changes under a release: a prod plan without the pins fails here (human action H-140).
locals {
  armor_unpinned_rules = module.load_balancer.unpinned_rules
}

resource "terraform_data" "armor_version_pins" {
  input = var.armor_rule_versions

  lifecycle {
    precondition {
      condition     = !local.is_prod || length(local.armor_unpinned_rules) == 0
      error_message = "Pin these Cloud Armor preconfigured rules in armor_rule_versions before a prod plan (read them with gcloud compute security-policies list-preconfigured-expression-sets): ${join(", ", local.armor_unpinned_rules)}."
    }
  }
}

# ---------------------------------------------------------------------------------------------
# DNS (Cloud DNS when the zone is in this project; otherwise the records are listed)
# ---------------------------------------------------------------------------------------------

module "dns" {
  source = "../dns"

  project_id               = var.project_id
  manage_zone              = var.dns_zone_name != null
  create_zone              = var.create_dns_zone
  zone_name                = var.dns_zone_name
  domain_name              = var.domain_name
  hosts                    = module.load_balancer.hosts
  ip_address               = module.load_balancer.ip_address
  dns_authorization_record = module.load_balancer.dns_authorization_record
}

# The one way in from the internet: a global external Application Load Balancer with Google-
# managed certificates from Certificate Manager, Cloud Armor (OWASP CRS preconfigured rules at
# pinned versions, rate limiting, PowerSync's admin API closed, Flagsmith allowlisted) on every
# backend, and Cloud CDN on a separate backend for the web tier's static files only.
# The load balancer, its certificates and Cloud Armor are global resources that hold no personal
# data; the Cloud Run services behind them run in europe-west2, and their ingress setting admits
# only this load balancer.

locals {
  hosts          = { for host, service in var.backends : host => "${host}.${var.domain_name}" }
  pinned_version = { for r in var.armor_rules : r => lookup(var.armor_rule_versions, r, var.armor_default_version) }
  unpinned_rules = sort([for r in var.armor_rules : r if !contains(keys(var.armor_rule_versions), r)])
}

# ---------------------------------------------------------------------------------------------
# Certificates (Certificate Manager, DNS authorisation)
# ---------------------------------------------------------------------------------------------

resource "google_certificate_manager_dns_authorization" "this" {
  project = var.project_id
  name    = "${var.name_prefix}-dns-auth"
  domain  = var.domain_name
}

resource "google_certificate_manager_certificate" "this" {
  project = var.project_id
  name    = "${var.name_prefix}-cert"
  scope   = "DEFAULT"

  managed {
    domains            = [var.domain_name, "*.${var.domain_name}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.this.id]
  }
}

resource "google_certificate_manager_certificate_map" "this" {
  project = var.project_id
  name    = "${var.name_prefix}-certs"
}

resource "google_certificate_manager_certificate_map_entry" "hosts" {
  for_each = local.hosts

  project      = var.project_id
  name         = "${var.name_prefix}-${each.key}"
  map          = google_certificate_manager_certificate_map.this.name
  certificates = [google_certificate_manager_certificate.this.id]
  hostname     = each.value
}

# ---------------------------------------------------------------------------------------------
# Cloud Armor
# ---------------------------------------------------------------------------------------------

resource "google_compute_security_policy" "this" {
  project = var.project_id
  name    = "${var.name_prefix}-armor"
  type    = "CLOUD_ARMOR"

  advanced_options_config {
    json_parsing = "STANDARD"
    log_level    = "NORMAL"
  }

  # PowerSync's admin API (and any other restricted path) is never served from the internet.
  dynamic "rule" {
    for_each = { for i, h in keys(var.restricted_paths) : h => i }

    content {
      action      = "deny(404)"
      priority    = 100 + rule.value
      description = "No ${rule.key} admin paths from the internet"

      match {
        expr {
          expression = "request.headers['host'].lower().startsWith('${rule.key}.') && (${join(" || ", [for p in var.restricted_paths[rule.key] : "request.path.lower().startsWith('${lower(p)}')"])})"
        }
      }
    }
  }

  # Hosts reached only from listed addresses (Flagsmith).
  dynamic "rule" {
    for_each = { for i, h in keys(var.allowlisted_hosts) : h => i }

    content {
      action      = "deny(403)"
      priority    = 200 + rule.value
      description = "${rule.key} only from its allowlist"

      match {
        expr {
          expression = length(var.allowlisted_hosts[rule.key]) == 0 ? "request.headers['host'].lower().startsWith('${rule.key}.')" : "request.headers['host'].lower().startsWith('${rule.key}.') && !(${join(" || ", [for r in var.allowlisted_hosts[rule.key] : "inIpRange(origin.ip, '${r}')"])})"
        }
      }
    }
  }

  dynamic "rule" {
    for_each = { for i, r in var.armor_rules : r => i }

    content {
      action      = "deny(403)"
      priority    = 1000 + rule.value
      description = "OWASP CRS ${rule.key} (${local.pinned_version[rule.key]})"

      match {
        expr {
          expression = "evaluatePreconfiguredWaf('${rule.key}-${local.pinned_version[rule.key]}', {'sensitivity': ${var.armor_sensitivity}})"
        }
      }
    }
  }

  # Harbour's own egress (the web tier rendering pages for everyone) is not rate limited as one
  # client; the WAF rules above still apply to it.
  dynamic "rule" {
    for_each = length(var.trusted_source_ranges) > 0 ? [1] : []

    content {
      action      = "allow"
      priority    = 1900
      description = "Harbour's own egress addresses"

      match {
        versioned_expr = "SRC_IPS_V1"

        config {
          src_ip_ranges = var.trusted_source_ranges
        }
      }
    }
  }

  rule {
    action      = "throttle"
    priority    = 2000
    description = "Per-client rate limit"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = var.rate_limit_per_minute
        interval_sec = 60
      }
    }
  }

  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"

    match {
      versioned_expr = "SRC_IPS_V1"

      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------------------------

resource "google_compute_region_network_endpoint_group" "this" {
  for_each = var.backends

  project               = var.project_id
  name                  = "${var.name_prefix}-${each.key}"
  region                = var.region
  network_endpoint_type = "SERVERLESS"

  cloud_run {
    service = each.value
  }
}

resource "google_compute_backend_service" "this" {
  for_each = var.backends

  project               = var.project_id
  name                  = "${var.name_prefix}-${each.key}"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.this.id
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.this[each.key].id
  }

  log_config {
    enable      = true
    sample_rate = var.log_sample_rate
  }
}

# Static files only: the same web service, through Cloud CDN, for cdn_paths alone. Pages never
# go through this backend, so nothing with personal data can be cached at the edge.
resource "google_compute_backend_service" "static" {
  count = var.cdn_host == null ? 0 : 1

  project               = var.project_id
  name                  = "${var.name_prefix}-${var.cdn_host}-static"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = google_compute_security_policy.this.id
  enable_cdn            = true

  backend {
    group = google_compute_region_network_endpoint_group.this[var.cdn_host].id
  }

  log_config {
    enable      = true
    sample_rate = var.log_sample_rate
  }

  cdn_policy {
    cache_mode       = "USE_ORIGIN_HEADERS"
    negative_caching = false

    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = false
    }
  }
}

resource "google_compute_url_map" "https" {
  project         = var.project_id
  name            = "${var.name_prefix}-https"
  default_service = google_compute_backend_service.this[var.default_host].id

  dynamic "host_rule" {
    for_each = local.hosts

    content {
      hosts        = [host_rule.value]
      path_matcher = host_rule.key
    }
  }

  dynamic "path_matcher" {
    for_each = local.hosts

    content {
      name            = path_matcher.key
      default_service = google_compute_backend_service.this[path_matcher.key].id

      dynamic "path_rule" {
        for_each = path_matcher.key == var.cdn_host ? [1] : []

        content {
          paths   = var.cdn_paths
          service = google_compute_backend_service.static[0].id
        }
      }
    }
  }
}

resource "google_compute_global_address" "this" {
  project      = var.project_id
  name         = "${var.name_prefix}-lb"
  address_type = "EXTERNAL"
  ip_version   = "IPV4"
}

resource "google_compute_ssl_policy" "this" {
  project         = var.project_id
  name            = "${var.name_prefix}-tls"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

resource "google_compute_target_https_proxy" "this" {
  project         = var.project_id
  name            = "${var.name_prefix}-https"
  url_map         = google_compute_url_map.https.id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.this.id}"
  ssl_policy      = google_compute_ssl_policy.this.id
}

resource "google_compute_global_forwarding_rule" "https" {
  project               = var.project_id
  name                  = "${var.name_prefix}-https"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.this.id
  port_range            = "443"
  target                = google_compute_target_https_proxy.this.id
}

# Plain HTTP only redirects to HTTPS.
resource "google_compute_url_map" "redirect" {
  project = var.project_id
  name    = "${var.name_prefix}-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  project = var.project_id
  name    = "${var.name_prefix}-redirect"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  project               = var.project_id
  name                  = "${var.name_prefix}-http"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.this.id
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
}

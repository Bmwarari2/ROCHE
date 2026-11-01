variable "project_id" {
  type = string
}

variable "region" {
  description = "Region of the Cloud Run services (serverless network endpoint groups)."
  type        = string
  default     = "europe-west2"
}

variable "name_prefix" {
  type = string
}

variable "domain_name" {
  description = "The environment's domain; hosts are app., api., sync. and flags. under it."
  type        = string
}

variable "backends" {
  description = "Host name => Cloud Run service name. The host named by cdn_host gets Cloud CDN."
  type        = map(string)
}

variable "default_host" {
  description = "The host whose backend serves requests for any other host name."
  type        = string
}

variable "cdn_host" {
  description = "The host whose static files Cloud CDN caches (the web tier): only cdn_paths go through the CDN backend; every page goes through a backend with no CDN."
  type        = string
  default     = null
}

variable "cdn_paths" {
  description = "Paths of immutable static files on cdn_host (Next.js build output)."
  type        = list(string)
  default     = ["/_next/static/*"]
}

variable "trusted_source_ranges" {
  description = "Harbour's own egress addresses (Cloud NAT): exempt from the per-client rate limit, because every server-rendered page reaches the API from them."
  type        = list(string)
  default     = []
}

variable "restricted_paths" {
  description = "Host prefix => path prefixes never served from the internet (PowerSync's admin API)."
  type        = map(list(string))
  default     = { sync = ["/api/admin"] }
}

variable "allowlisted_hosts" {
  description = "Host prefix => source ranges allowed to reach it (empty list: nobody). Flagsmith's dashboard and API are reached from Harbour's own addresses and the named admin ranges only."
  type        = map(list(string))
  default     = {}
}

variable "armor_rules" {
  description = "Cloud Armor preconfigured WAF rules (OWASP CRS) to deny, by rule name."
  type        = list(string)
  default = [
    "sqli",
    "xss",
    "lfi",
    "rfi",
    "rce",
    "methodenforcement",
    "scannerdetection",
    "protocolattack",
    "sessionfixation",
  ]
}

variable "armor_rule_versions" {
  description = "Pinned version of each preconfigured rule, for example { sqli = \"v33-stable\" }. Every rule must be pinned in prod."
  type        = map(string)
  default     = {}
}

variable "armor_default_version" {
  description = "Version used outside prod for a rule that is not pinned."
  type        = string
  default     = "v33-stable"
}

variable "armor_sensitivity" {
  description = "OWASP CRS paranoia level for the preconfigured rules (1 is the least false-positive prone)."
  type        = number
  default     = 1
}

variable "rate_limit_per_minute" {
  description = "Requests per minute per client IP before Cloud Armor throttles with 429."
  type        = number
  default     = 600
}

variable "log_sample_rate" {
  type    = number
  default = 1
}

variable "learn" {
  description = <<-EOT
    The e-learning content origin (ADR-0093), or null when courses do not launch. `hostname` is on
    another registrable domain (`domain`) from domain_name, with its own certificate. Only paths under
    `path_prefix` reach `backend` (a key of backends); everything else on that host is a fixed 404.
    Responses carry no referrer and no powerful-feature permissions, and no X-Frame-Options is added:
    the app frames the runtime page, whose own frame-ancestors decides who may.
  EOT
  type = object({
    hostname    = string
    domain      = string
    backend     = string
    path_prefix = string
  })
  default = null

  validation {
    condition     = var.learn == null ? true : startswith(var.learn.path_prefix, "/") && endswith(var.learn.path_prefix, "/")
    error_message = "learn.path_prefix must start and end with a slash, for example /learn/."
  }

  validation {
    condition     = var.learn == null ? true : endswith(var.learn.hostname, ".${var.learn.domain}")
    error_message = "learn.hostname must be a host under learn.domain."
  }
}

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
  description = "The host whose static files Cloud CDN caches (the web tier). Pages are private and never cached: Cloud CDN follows the origin's Cache-Control."
  type        = string
  default     = null
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

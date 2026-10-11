variable "domain_name" {
  description = "Primary domain name on the certificate."
  type        = string
}

variable "subject_alternative_names" {
  description = "Additional names on the certificate, for example a wildcard."
  type        = list(string)
  default     = []
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for DNS validation. Null means the validation records are created by hand from the domain_validation_records output."
  type        = string
  default     = null
}

variable "domain" {
  description = "Sending domain, for example dev.harbour.example."
  type        = string
}

variable "configuration_set_name" {
  description = "SES configuration set name."
  type        = string
}

variable "mail_from_subdomain" {
  description = "Subdomain used as the custom MAIL FROM (bounce) domain, so SPF aligns with the sending domain for DMARC."
  type        = string
  default     = "mail"
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for the DKIM, MAIL FROM and DMARC records. Null means they are created by hand from the dns_records output."
  type        = string
  default     = null
}

variable "dmarc_policy" {
  description = "DMARC record value published at _dmarc.<domain>."
  type        = string
  default     = "v=DMARC1; p=quarantine; adkim=s; aspf=s"
}

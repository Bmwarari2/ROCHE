variable "project_id" {
  type = string
}

variable "manage_zone" {
  description = "Create the records in a Cloud DNS zone in this project (false: list them for the domain's own DNS)."
  type        = bool
  default     = false
}

variable "create_zone" {
  description = "Create the zone (true) or use an existing one named zone_name (false)."
  type        = bool
  default     = false
}

variable "zone_name" {
  type    = string
  default = null
}

variable "domain_name" {
  type = string
}

variable "hosts" {
  description = "Full host names that point at the load balancer."
  type        = map(string)
}

variable "ip_address" {
  description = "The load balancer's address."
  type        = string
}

variable "dns_authorization_record" {
  description = "Certificate Manager's DNS authorisation record ({ name, type, data })."
  type = list(object({
    name = string
    type = string
    data = string
  }))
}

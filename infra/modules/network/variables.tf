variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

variable "name_prefix" {
  type = string
}

variable "subnet_cidr" {
  description = "The subnet Cloud Run uses for Direct VPC egress."
  type        = string
  default     = "10.42.0.0/20"
}

variable "private_services_prefix_length" {
  description = "Size of the range reserved for private services access (Cloud SQL)."
  type        = number
  default     = 20
}

variable "nat_address_count" {
  description = "Static addresses for Cloud NAT. Every service sends all its traffic through the VPC, so its calls to the internet (the web tier calling the API through the load balancer, SMTP, JWKS) come from these addresses, which the API trusts as proxies and Cloud Armor exempts from the rate limit."
  type        = number
  default     = 2

  validation {
    condition     = var.nat_address_count >= 1
    error_message = "At least one static NAT address is needed."
  }
}

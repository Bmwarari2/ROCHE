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

variable "enable_nat" {
  description = "Cloud NAT for egress from the VPC to the internet (not needed while Cloud Run sends only private ranges through the VPC)."
  type        = bool
  default     = false
}

variable "name_prefix" {
  description = "Prefix for resource names, for example harbour-dev."
  type        = string
}

variable "cidr_block" {
  description = "IPv4 CIDR block for the VPC. A /16 leaves room for the subnet layout below."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.cidr_block, 0)) && tonumber(split("/", var.cidr_block)[1]) <= 16
    error_message = "The VPC CIDR block must be a valid IPv4 CIDR of /16 or larger."
  }
}

variable "availability_zones" {
  description = "Availability zones to spread subnets across. London has three."
  type        = list(string)
  default     = ["eu-west-2a", "eu-west-2b", "eu-west-2c"]

  validation {
    condition     = length(var.availability_zones) >= 2 && alltrue([for az in var.availability_zones : startswith(az, "eu-west-2")])
    error_message = "Use at least two availability zones, all in eu-west-2 (London)."
  }
}

variable "nat_gateway_per_az" {
  description = "Create one NAT gateway per availability zone (resilient, used in prod) instead of a single shared one (cheaper, used in dev)."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "AWS services reached through interface VPC endpoints so that traffic to them never leaves the AWS network."
  type        = list(string)
  default     = ["secretsmanager", "ecr.api", "ecr.dkr", "kms", "logs", "sts"]
}

variable "interface_endpoint_az_count" {
  description = "How many availability zones host interface endpoint network interfaces. Fewer is cheaper; all zones survive a zone outage."
  type        = number
  default     = 3

  validation {
    condition     = var.interface_endpoint_az_count >= 1
    error_message = "At least one availability zone must host the interface endpoints."
  }
}

variable "flow_log_kms_key_arn" {
  description = "KMS key ARN (logs purpose) used to encrypt the flow log group."
  type        = string
}

variable "flow_log_retention_days" {
  description = "Retention for VPC flow logs. Security logs are kept for at least 6 months (section 5.3)."
  type        = number
  default     = 365

  validation {
    condition     = var.flow_log_retention_days >= 180
    error_message = "Security logs must be retained for at least 180 days."
  }
}

variable "log_group_deletion_protection" {
  description = "Protect the flow log group from deletion."
  type        = bool
  default     = false
}

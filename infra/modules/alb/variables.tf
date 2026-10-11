variable "name" {
  description = "Load balancer name, for example harbour-dev."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "vpc_cidr_block" {
  description = "VPC CIDR block; the load balancer may only send traffic to targets inside it."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs, one per availability zone."
  type        = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate ARN (eu-west-2) for the HTTPS listener."
  type        = string
}

variable "additional_certificate_arns" {
  description = "Further ACM certificates served by SNI, keyed by a static name."
  type        = map(string)
  default     = {}
}

variable "ssl_policy" {
  description = "TLS negotiation policy: TLS 1.3 with TLS 1.2 fallback and forward-secret ciphers only."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "target_ports" {
  description = "Container ports the load balancer forwards to."
  type        = set(number)
}

variable "access_log_bucket" {
  description = "Bucket (SSE-S3, with the ALB delivery policy) that receives access logs under alb/."
  type        = string
}

variable "idle_timeout" {
  description = "Idle timeout in seconds. PowerSync holds long-lived streaming connections, so this is longer than the default 60."
  type        = number
  default     = 120
}

variable "deletion_protection" {
  description = "Block deletion of the load balancer."
  type        = bool
  default     = true
}

variable "web_acl_arn" {
  description = "Regional WAF web ACL ARN to associate. Null leaves the load balancer without WAF."
  type        = string
  default     = null
}

variable "enable_waf" {
  description = "Associate web_acl_arn with the load balancer. A separate flag because the ARN is unknown until apply."
  type        = bool
  default     = true
}

variable "name" {
  description = "Short service name, for example api, worker, web or powersync."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource names, for example harbour-dev."
  type        = string
}

variable "cluster" {
  description = "ECS cluster name or ARN."
  type        = string
}

variable "cluster_name" {
  description = "ECS cluster name (used for autoscaling resource IDs)."
  type        = string
}

variable "create_service" {
  description = "Create a long-running service. False creates only the task definition, for one-off tasks such as database migrations."
  type        = bool
  default     = true
}

variable "image" {
  description = "Full image reference including an immutable tag or digest."
  type        = string
}

variable "cpu" {
  description = "Task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Task memory in MiB."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64. Images must be built for the chosen architecture."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "The CPU architecture must be X86_64 or ARM64."
  }
}

variable "command" {
  description = "Container command override. Null uses the image default."
  type        = list(string)
  default     = null
}

variable "container_port" {
  description = "Port the container listens on. Null for services without inbound traffic (workers)."
  type        = number
  default     = null
}

variable "user" {
  description = "User and group the container runs as. Never root."
  type        = string
  default     = "1000:1000"

  validation {
    condition     = !contains(["root", "0", "0:0"], var.user)
    error_message = "Containers must not run as root."
  }
}

variable "writable_paths" {
  description = "Paths mounted as writable task-local scratch volumes; the root filesystem is read-only."
  type        = list(string)
  default     = ["/tmp"]
}

variable "environment" {
  description = "Plain environment variables. Never put secrets here; use secrets."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variables injected from Secrets Manager at task start, as NAME => secret ARN (optionally with :json-key:: suffix)."
  type        = map(string)
  default     = {}
}

variable "secrets_kms_key_arn" {
  description = "KMS key ARN (secrets purpose) the execution role may use to decrypt injected secrets."
  type        = string
}

variable "health_check_command" {
  description = "Optional container health check command, for example [\"CMD\", \"node\", \"healthcheck.js\"]."
  type        = list(string)
  default     = null
}

variable "stop_timeout" {
  description = "Seconds the container gets to drain after SIGTERM before SIGKILL (Fargate maximum 120)."
  type        = number
  default     = 30
}

variable "vpc_id" {
  description = "VPC ID."
  type        = string
}

variable "subnet_ids" {
  description = "Private subnet IDs for the tasks."
  type        = list(string)
}

variable "allow_https_egress" {
  description = "Allow outbound HTTPS to the internet through NAT (SES, Sentry EU, Grafana Cloud UK, Expo push, JWKS)."
  type        = bool
  default     = true
}

variable "egress_security_groups" {
  description = "Additional egress allowed to other security groups, keyed by a static name, for example { main_db = { security_group_id = \"sg-...\", port = 5432 } }."
  type = map(object({
    security_group_id = string
    port              = number
  }))
  default = {}
}

variable "load_balancer" {
  description = "Attach the service to an ALB listener with host-based routing. Null for services without inbound traffic."
  type = object({
    listener_arn          = string
    security_group_id     = string
    host_headers          = list(string)
    priority              = number
    health_check_path     = string
    health_check_matcher  = optional(string, "200-399")
    deregistration_delay  = optional(number, 30)
    required_header_name  = optional(string)
    required_header_value = optional(string)
  })
  default = null
}

variable "health_check_grace_period_seconds" {
  description = "Seconds to ignore failing load balancer health checks after a task starts."
  type        = number
  default     = 60
}

variable "desired_count" {
  description = "Initial number of tasks; autoscaling owns the count afterwards."
  type        = number
  default     = 1
}

variable "min_capacity" {
  description = "Autoscaling minimum task count."
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Autoscaling maximum task count."
  type        = number
  default     = 4
}

variable "cpu_target_percent" {
  description = "Target average CPU utilisation for autoscaling."
  type        = number
  default     = 60
}

variable "memory_target_percent" {
  description = "Target average memory utilisation for autoscaling."
  type        = number
  default     = 75
}

variable "use_fargate_spot" {
  description = "Run on Fargate Spot (cheaper, can be interrupted). Suitable for dev only."
  type        = bool
  default     = false
}

variable "task_role_statements" {
  description = "IAM statements granted to the application (task role)."
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
    conditions = optional(list(object({
      test     = string
      variable = string
      values   = list(string)
    })), [])
  }))
  default = []
}

variable "log_kms_key_arn" {
  description = "KMS key ARN (logs purpose) for the service log group."
  type        = string
}

variable "log_retention_days" {
  description = "Log retention in days. Security-relevant logs are kept at least 6 months (section 5.3)."
  type        = number
  default     = 365

  validation {
    condition     = var.log_retention_days >= 180
    error_message = "Service logs must be retained for at least 180 days."
  }
}

variable "log_group_deletion_protection" {
  description = "Protect the service log group from deletion."
  type        = bool
  default     = false
}

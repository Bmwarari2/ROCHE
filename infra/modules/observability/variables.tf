variable "name_prefix" {
  description = "Prefix for alarm and topic names, for example harbour-dev."
  type        = string
}

variable "alerts_kms_key_arn" {
  description = "KMS key ARN (alerts purpose) for the SNS topic."
  type        = string
}

variable "alert_email_addresses" {
  description = "Email addresses subscribed to alerts (each must confirm the subscription). Use a team mailbox, not a person."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix for load balancer alarms."
  type        = string
}

variable "target_group_arn_suffixes" {
  description = "Target group ARN suffixes by service name, for unhealthy host and target 5xx alarms."
  type        = map(string)
  default     = {}
}

variable "ecs_cluster_name" {
  description = "ECS cluster name."
  type        = string
}

variable "ecs_services" {
  description = "ECS services to watch, with the minimum number of running tasks expected."
  type        = map(object({ min_running_tasks = number }))
  default     = {}
}

variable "rds_instances" {
  description = "RDS instances to watch, keyed by a static name, with whether a logical replication slot (PowerSync) should be watched."
  type = map(object({
    identifier          = string
    logical_replication = optional(bool, false)
    read_replica        = optional(bool, false)
  }))
  default = {}
}

variable "elb_5xx_threshold" {
  description = "Load balancer generated 5xx responses per 5 minutes that raise an alarm."
  type        = number
  default     = 10
}

variable "target_5xx_threshold" {
  description = "Application 5xx responses per 5 minutes that raise an alarm."
  type        = number
  default     = 25
}

variable "rds_cpu_threshold_percent" {
  description = "RDS CPU utilisation that raises an alarm."
  type        = number
  default     = 80
}

variable "rds_free_storage_threshold_bytes" {
  description = "RDS free storage below which an alarm is raised (default 10 GiB)."
  type        = number
  default     = 10737418240
}

variable "replication_slot_lag_threshold_bytes" {
  description = "Oldest replication slot lag that raises an alarm (default 1 GiB). A growing slot means PowerSync has stopped consuming changes."
  type        = number
  default     = 1073741824
}

variable "replica_lag_threshold_seconds" {
  description = "Read replica lag that raises an alarm."
  type        = number
  default     = 60
}

variable "worker_log_group_name" {
  description = "CloudWatch log group of the worker service, whose structured lines raise the escalation.unrouted.daily and worker.job.failed alarms."
  type        = string
}

variable "worker_job_failure_threshold" {
  description = "Failed worker jobs (worker.job.failed lines) per period that raise an alarm."
  type        = number
  default     = 1
}

variable "worker_job_failure_period_seconds" {
  description = "Period over which failed worker jobs are counted."
  type        = number
  default     = 900
}


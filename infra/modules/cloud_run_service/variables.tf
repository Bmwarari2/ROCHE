variable "project_id" {
  type = string
}

variable "region" {
  type    = string
  default = "europe-west2"
}

variable "name" {
  description = "Service or job name, for example harbour-dev-api."
  type        = string
}

variable "kind" {
  description = "service (long-running) or job (run on demand, for example migrations)."
  type        = string
  default     = "service"

  validation {
    condition     = contains(["service", "job"], var.kind)
    error_message = "kind must be service or job."
  }
}

variable "image" {
  type = string
}

variable "command" {
  type    = list(string)
  default = null
}

variable "args" {
  type    = list(string)
  default = null
}

variable "port" {
  description = "Container port for a service."
  type        = number
  default     = 8080
}

variable "cpu" {
  type    = string
  default = "1"
}

variable "memory" {
  type    = string
  default = "1Gi"
}

variable "min_instances" {
  type    = number
  default = 0
}

variable "max_instances" {
  type    = number
  default = 2
}

variable "cpu_always_allocated" {
  description = "Keep CPU between requests (background work: the worker, PowerSync, ClamAV)."
  type        = bool
  default     = false
}

variable "ingress" {
  description = "INGRESS_TRAFFIC_INTERNAL_ONLY or INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER (never ALL)."
  type        = string
  default     = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.ingress)
    error_message = "A service is reached through the load balancer or from inside the project only."
  }
}

variable "behind_load_balancer" {
  description = "Requests arrive through the external load balancer, which carries no Google identity, so the invoker check is off and ingress restricts the path."
  type        = bool
  default     = false
}

variable "env" {
  description = "Plain configuration. Never secrets."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Environment variables read from Secret Manager: name => full secret id (latest version)."
  type        = map(string)
  default     = {}
}

variable "secret_volumes" {
  description = "Secrets mounted as files: volume name => { secret = full secret id, mount_path, file }."
  type = map(object({
    secret     = string
    mount_path = string
    file       = string
  }))
  default = {}
}

variable "sidecars" {
  description = "Containers beside the main one, sharing its network (they listen on 127.0.0.1)."
  type = list(object({
    name    = string
    image   = string
    cpu     = optional(string, "1")
    memory  = optional(string, "2Gi")
    env     = optional(map(string), {})
    command = optional(list(string))
    args    = optional(list(string))
    # A TCP port the sidecar answers on, used as its startup probe.
    probe_port = optional(number)
  }))
  default = []
}

variable "vpc_egress" {
  description = "ALL_TRAFFIC sends internet traffic through Cloud NAT's static addresses; PRIVATE_RANGES_ONLY only Cloud SQL."
  type        = string
  default     = "ALL_TRAFFIC"

  validation {
    condition     = contains(["ALL_TRAFFIC", "PRIVATE_RANGES_ONLY"], var.vpc_egress)
    error_message = "vpc_egress must be ALL_TRAFFIC or PRIVATE_RANGES_ONLY."
  }
}

variable "network_id" {
  type = string
}

variable "subnet_id" {
  type = string
}

variable "health_path" {
  description = "HTTP path for the startup and liveness probes (null: TCP startup probe only)."
  type        = string
  default     = null
}

variable "timeout_seconds" {
  description = "Request timeout for a service, or task timeout for a job."
  type        = number
  default     = 300
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "labels" {
  type    = map(string)
  default = {}
}

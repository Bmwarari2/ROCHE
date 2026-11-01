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

variable "keys" {
  description = "Keys to create, by purpose, with the members that may encrypt and decrypt with each."
  type        = map(list(string))
}

variable "rotation_period" {
  description = "Automatic rotation: every 90 days, stricter than the yearly rotation section 5.3 sets."
  type        = string
  default     = "7776000s"
}

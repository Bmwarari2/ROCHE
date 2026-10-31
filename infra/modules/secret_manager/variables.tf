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

variable "secrets" {
  description = "Secrets to create, by short name (letters, digits, - and _), with a description."
  type        = map(string)
}

variable "kms_key_id" {
  description = "Key that encrypts every secret (CMEK)."
  type        = string
}

variable "labels" {
  type    = map(string)
  default = {}
}

variable "name_prefix" {
  description = "Repository name prefix, for example harbour."
  type        = string
}

variable "repositories" {
  description = "Repository names (without the prefix), for example api, worker, web."
  type        = set(string)
}

variable "kms_key_arn" {
  description = "KMS key ARN (ecr purpose) used to encrypt images."
  type        = string
}

variable "untagged_image_expiry_days" {
  description = "Days after which untagged images are deleted."
  type        = number
  default     = 14
}

variable "max_tagged_images" {
  description = "Number of tagged images to keep per repository; older ones are deleted."
  type        = number
  default     = 100
}

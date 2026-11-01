variable "billing_account_id" {
  description = "Billing account the project is charged to (null: no budget)."
  type        = string
  default     = null
}

variable "project_number" {
  type = string
}

variable "name" {
  type = string
}

variable "monthly_limit" {
  description = "Monthly budget in pounds sterling."
  type        = number
}

variable "notification_channel_ids" {
  type    = list(string)
  default = []
}

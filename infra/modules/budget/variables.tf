variable "name" {
  description = "Budget name, for example harbour-dev-monthly."
  type        = string
}

variable "monthly_limit" {
  description = "Monthly cost limit, in the currency of the AWS account's billing (normally USD)."
  type        = number
}

variable "currency" {
  description = "Currency unit of the limit; must match the account's billing currency."
  type        = string
  default     = "USD"
}

variable "thresholds_percent" {
  description = "Percentages of the limit at which to notify. Actual spend uses each threshold; forecast spend uses 100."
  type        = list(number)
  default     = [50, 80, 100]
}

variable "sns_topic_arn" {
  description = "SNS topic for notifications (the alerts topic)."
  type        = string
}

variable "email_addresses" {
  description = "Email addresses notified directly (in addition to the SNS topic)."
  type        = list(string)
  default     = []
}

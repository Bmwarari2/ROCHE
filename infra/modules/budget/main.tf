# Monthly cost budget with alerts on actual spend and on the end-of-month forecast.

resource "aws_budgets_budget" "monthly" {
  name         = var.name
  budget_type  = "COST"
  limit_amount = format("%.2f", var.monthly_limit)
  limit_unit   = var.currency
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = toset(var.thresholds_percent)

    content {
      comparison_operator        = "GREATER_THAN"
      notification_type          = "ACTUAL"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      subscriber_sns_topic_arns  = [var.sns_topic_arn]
      subscriber_email_addresses = var.email_addresses
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    notification_type          = "FORECASTED"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_sns_topic_arns  = [var.sns_topic_arn]
    subscriber_email_addresses = var.email_addresses
  }
}

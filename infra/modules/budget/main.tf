# A monthly budget in pounds for the environment's project, alerting at 50%, 80% and 100% of the
# actual spend and at 100% of the forecast.

resource "google_billing_budget" "this" {
  count = var.billing_account_id == null ? 0 : 1

  billing_account = var.billing_account_id
  display_name    = var.name

  budget_filter {
    projects               = ["projects/${var.project_number}"]
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }

  amount {
    specified_amount {
      currency_code = "GBP"
      units         = tostring(var.monthly_limit)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.5, 0.8, 1.0]

    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = var.notification_channel_ids
    disable_default_iam_recipients   = false
  }
}

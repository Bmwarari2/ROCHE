output "notification_channel_ids" {
  value = local.channels
}

output "log_metric_filters" {
  description = "Filters of the worker log metrics, by purpose."
  value       = local.log_metric_filters
}

output "log_alert_rules" {
  description = "How each worker log metric alerts, by purpose."
  value       = local.log_alert_rules
}

output "security_log_bucket" {
  value = {
    location       = google_logging_project_bucket_config.security.location
    retention_days = google_logging_project_bucket_config.security.retention_days
    locked         = var.lock_security_logs
  }
}

output "security_sink_filter" {
  value = local.security_filter
}

output "app_sink_filter" {
  value = local.app_filter
}

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

output "dmd_log_metric_filters" {
  description = "Filters of the dm+d job's log metrics, by purpose."
  value       = local.dmd_log_metric_filters
}

output "dmd_log_alert_rules" {
  description = "How each dm+d job log metric alerts, by purpose."
  value       = local.dmd_log_alert_rules
}

output "dmd_execution_failed_filter" {
  description = "Filter of the alert on a failed execution of the dm+d job."
  value       = local.dmd_execution_failed_filter
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

output "dmd_alert_policy_names" {
  description = "The dm+d alert policies created (none where the job does not download from TRUD)."
  value = concat(
    [for p in google_monitoring_alert_policy.dmd_events : p.display_name],
    [for p in google_monitoring_alert_policy.dmd_execution_failed : p.display_name],
  )
}

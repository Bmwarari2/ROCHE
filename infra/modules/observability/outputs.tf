output "alerts_topic_arn" {
  description = "SNS topic that receives every alarm and budget notification."
  value       = aws_sns_topic.alerts.arn
}

output "log_alarm_names" {
  description = "Alarms raised from the worker's structured log lines, by purpose."
  value = {
    escalation_unrouted_daily = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.alarm_name
    worker_job_failed         = aws_cloudwatch_metric_alarm.worker_job_failed.alarm_name
  }
}

output "log_metric_filter_patterns" {
  description = "Filter patterns of the worker log metric filters, by purpose."
  value = {
    escalation_unrouted_daily = aws_cloudwatch_log_metric_filter.escalation_unrouted_daily.pattern
    worker_job_failed         = aws_cloudwatch_log_metric_filter.worker_job_failed.pattern
  }
}


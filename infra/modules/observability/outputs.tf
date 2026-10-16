output "alerts_topic_arn" {
  description = "SNS topic that receives every alarm and budget notification."
  value       = aws_sns_topic.alerts.arn
}

output "log_alarm_names" {
  description = "Alarms raised from the worker's structured log lines, by purpose."
  value = {
    escalation_unrouted_daily = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.alarm_name
    worker_job_failed         = aws_cloudwatch_metric_alarm.worker_job_failed.alarm_name
    export_foreign_rows       = aws_cloudwatch_metric_alarm.export_foreign_rows.alarm_name
  }
}

output "log_metric_filter_patterns" {
  description = "Filter patterns of the worker log metric filters, by purpose."
  value = {
    escalation_unrouted_daily = aws_cloudwatch_log_metric_filter.escalation_unrouted_daily.pattern
    worker_job_failed         = aws_cloudwatch_log_metric_filter.worker_job_failed.pattern
    export_foreign_rows       = aws_cloudwatch_log_metric_filter.export_foreign_rows.pattern
  }
}

output "log_alarm_rules" {
  description = "How each worker log alarm is wired: the log group its filter reads, the metric the filter writes and the alarm reads, and when the alarm fires."
  value = {
    escalation_unrouted_daily = {
      log_group_name      = aws_cloudwatch_log_metric_filter.escalation_unrouted_daily.log_group_name
      filter_metric       = "${aws_cloudwatch_log_metric_filter.escalation_unrouted_daily.metric_transformation[0].namespace}/${aws_cloudwatch_log_metric_filter.escalation_unrouted_daily.metric_transformation[0].name}"
      alarm_metric        = "${aws_cloudwatch_metric_alarm.escalation_unrouted_daily.namespace}/${aws_cloudwatch_metric_alarm.escalation_unrouted_daily.metric_name}"
      statistic           = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.statistic
      period              = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.period
      threshold           = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.threshold
      comparison_operator = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.comparison_operator
      treat_missing_data  = aws_cloudwatch_metric_alarm.escalation_unrouted_daily.treat_missing_data
    }
    worker_job_failed = {
      log_group_name      = aws_cloudwatch_log_metric_filter.worker_job_failed.log_group_name
      filter_metric       = "${aws_cloudwatch_log_metric_filter.worker_job_failed.metric_transformation[0].namespace}/${aws_cloudwatch_log_metric_filter.worker_job_failed.metric_transformation[0].name}"
      alarm_metric        = "${aws_cloudwatch_metric_alarm.worker_job_failed.namespace}/${aws_cloudwatch_metric_alarm.worker_job_failed.metric_name}"
      statistic           = aws_cloudwatch_metric_alarm.worker_job_failed.statistic
      period              = aws_cloudwatch_metric_alarm.worker_job_failed.period
      threshold           = aws_cloudwatch_metric_alarm.worker_job_failed.threshold
      comparison_operator = aws_cloudwatch_metric_alarm.worker_job_failed.comparison_operator
      treat_missing_data  = aws_cloudwatch_metric_alarm.worker_job_failed.treat_missing_data
    }
    export_foreign_rows = {
      log_group_name      = aws_cloudwatch_log_metric_filter.export_foreign_rows.log_group_name
      filter_metric       = "${aws_cloudwatch_log_metric_filter.export_foreign_rows.metric_transformation[0].namespace}/${aws_cloudwatch_log_metric_filter.export_foreign_rows.metric_transformation[0].name}"
      alarm_metric        = "${aws_cloudwatch_metric_alarm.export_foreign_rows.namespace}/${aws_cloudwatch_metric_alarm.export_foreign_rows.metric_name}"
      statistic           = aws_cloudwatch_metric_alarm.export_foreign_rows.statistic
      period              = aws_cloudwatch_metric_alarm.export_foreign_rows.period
      threshold           = aws_cloudwatch_metric_alarm.export_foreign_rows.threshold
      comparison_operator = aws_cloudwatch_metric_alarm.export_foreign_rows.comparison_operator
      treat_missing_data  = aws_cloudwatch_metric_alarm.export_foreign_rows.treat_missing_data
    }
  }
}


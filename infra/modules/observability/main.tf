# Logs and alerts in London. Security logs (audit logs, including Data Access, and Cloud Armor
# requests) go to their own bucket kept for at least 400 days, optionally locked; application
# logs to another. The worker's structured events (pino JSON) drive the alerts the on-call runbook
# names (docs/runbooks/on-call.md; HZ-070, HZ-073).

resource "google_logging_project_bucket_config" "security" {
  project        = var.project_id
  location       = var.region
  bucket_id      = "${var.name_prefix}-security"
  retention_days = var.security_log_retention_days
  locked         = var.lock_security_logs
  description    = "Audit logs and Cloud Armor requests"
}

resource "google_logging_project_bucket_config" "app" {
  project        = var.project_id
  location       = var.region
  bucket_id      = "${var.name_prefix}-app"
  retention_days = var.app_log_retention_days
  description    = "Cloud Run and Cloud SQL logs (opaque ids only)"
}

locals {
  security_filter = "logName:\"cloudaudit.googleapis.com\" OR (resource.type=\"http_load_balancer\" AND jsonPayload.enforcedSecurityPolicy.name:*)"
  app_filter      = "resource.type=(\"cloud_run_revision\" OR \"cloud_run_job\" OR \"cloudsql_database\") AND NOT logName:\"cloudaudit.googleapis.com\""
}

resource "google_logging_project_sink" "security" {
  project                = var.project_id
  name                   = "${var.name_prefix}-security"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.security.id}"
  filter                 = local.security_filter
  unique_writer_identity = true
}

resource "google_logging_project_sink" "app" {
  project                = var.project_id
  name                   = "${var.name_prefix}-app"
  destination            = "logging.googleapis.com/${google_logging_project_bucket_config.app.id}"
  filter                 = local.app_filter
  unique_writer_identity = true
}

# ---------------------------------------------------------------------------------------------
# Notification channels
# ---------------------------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_email_addresses)

  project      = var.project_id
  display_name = "Harbour alerts ${each.key}"
  type         = "email"

  labels = {
    email_address = each.key
  }
}

locals {
  channels = [for c in google_monitoring_notification_channel.email : c.id]

  # The worker logs JSON (pino), so each metric matches the structured `event` field.
  worker_events = {
    escalation_unrouted_daily = {
      event       = "escalation.unrouted.daily"
      period      = 3600
      description = "Escalations with nobody to route them to (HZ-073). Any line alerts, over an hour, so each daily run alerts again."
    }
    worker_job_failed = {
      event       = "worker.job.failed"
      period      = 900
      description = "One or more worker jobs failed in 15 minutes."
    }
    export_foreign_rows = {
      event       = "security.export.foreign_rows"
      period      = 900
      description = "An export met rows of another organisation (HZ-070)."
    }
  }

  log_metric_filters = {
    for k, v in local.worker_events :
    k => "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.worker_service_name}\" AND jsonPayload.event=\"${v.event}\""
  }
}

resource "google_logging_metric" "worker" {
  for_each = local.worker_events

  project = var.project_id
  name    = "${var.name_prefix}-${replace(each.key, "_", "-")}"
  filter  = local.log_metric_filters[each.key]

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

locals {
  log_alert_rules = {
    for k, v in local.worker_events : k => {
      metric      = "logging.googleapis.com/user/${google_logging_metric.worker[k].name}"
      aligner     = "ALIGN_SUM"
      period      = v.period
      threshold   = 0
      comparison  = "COMPARISON_GT"
      description = v.description
    }
  }
}

resource "google_monitoring_alert_policy" "worker_events" {
  for_each = local.log_alert_rules

  project               = var.project_id
  display_name          = "${var.name_prefix} ${each.key}"
  combiner              = "OR"
  notification_channels = local.channels

  documentation {
    content   = "${each.value.description} See docs/runbooks/on-call.md."
    mime_type = "text/markdown"
  }

  conditions {
    display_name = each.key

    condition_threshold {
      filter          = "metric.type=\"${each.value.metric}\" AND resource.type=\"cloud_run_revision\""
      comparison      = each.value.comparison
      threshold_value = each.value.threshold
      duration        = "0s"

      aggregations {
        alignment_period   = "${each.value.period}s"
        per_series_aligner = each.value.aligner
      }

      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "86400s"
  }
}

# The API answering with server errors.
resource "google_monitoring_alert_policy" "api_5xx" {
  project               = var.project_id
  display_name          = "${var.name_prefix} api 5xx"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "API server errors"

    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${var.api_service_name}\" AND metric.label.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 10
      duration        = "300s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

# Databases: CPU and disk.
resource "google_monitoring_alert_policy" "sql" {
  for_each = var.sql_instances

  project               = var.project_id
  display_name          = "${var.name_prefix} ${each.key} database"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "CPU above 80%"

    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${each.value}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  conditions {
    display_name = "Disk above 85%"

    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${each.value}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "900s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
}

# The worker and PowerSync must always run: no instance for 10 minutes alerts.
resource "google_monitoring_alert_policy" "always_on" {
  for_each = toset(var.always_on_services)

  project               = var.project_id
  display_name          = "${var.name_prefix} ${each.key} not running"
  combiner              = "OR"
  notification_channels = local.channels

  conditions {
    display_name = "No instances"

    condition_absent {
      filter   = "metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${each.key}\""
      duration = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

# A private bucket in London: uniform bucket-level access, public access prevented, objects
# encrypted with the project's key, versioned, with optional expiry and an optional retention
# policy that can be locked (write once, read many).

resource "google_storage_bucket" "this" {
  project                     = var.project_id
  name                        = var.name
  location                    = upper(var.location)
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.force_destroy
  labels                      = var.labels

  encryption {
    default_kms_key_name = var.kms_key_id
  }

  versioning {
    enabled = var.versioning
  }

  soft_delete_policy {
    retention_duration_seconds = var.soft_delete_days * 86400
  }

  dynamic "retention_policy" {
    for_each = var.retention_days == null ? [] : [var.retention_days]

    content {
      retention_period = retention_policy.value * 86400
      is_locked        = var.lock_retention_policy
    }
  }

  dynamic "lifecycle_rule" {
    for_each = var.delete_after_days == null ? [] : [var.delete_after_days]

    content {
      action {
        type = "Delete"
      }

      condition {
        age            = lifecycle_rule.value
        with_state     = "LIVE"
        matches_prefix = var.delete_after_days_prefix
      }
    }
  }

  dynamic "lifecycle_rule" {
    for_each = var.versioning && var.noncurrent_delete_after_days != null ? [var.noncurrent_delete_after_days] : []

    content {
      action {
        type = "Delete"
      }

      condition {
        days_since_noncurrent_time = lifecycle_rule.value
        with_state                 = "ARCHIVED"
      }
    }
  }

  dynamic "cors" {
    for_each = length(var.cors_origins) > 0 ? [1] : []

    content {
      origin          = var.cors_origins
      method          = ["GET", "PUT", "HEAD"]
      response_header = ["Content-Type", "Content-MD5", "x-goog-content-sha256"]
      max_age_seconds = 3600
    }
  }

  dynamic "logging" {
    for_each = var.access_log_bucket == null ? [] : [var.access_log_bucket]

    content {
      log_bucket = logging.value
    }
  }
}

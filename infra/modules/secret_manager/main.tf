# Regional secrets in London, created empty. Values are added inside Google Cloud by
# infra/scripts/seed-secrets.sh, so no password ever appears in Terraform state or plan output and
# the plan account never needs secretAccessor.

resource "google_secret_manager_regional_secret" "this" {
  for_each = var.secrets

  project   = var.project_id
  location  = var.region
  secret_id = "${var.name_prefix}-${each.key}"
  labels    = merge(var.labels, { purpose = replace(lower(each.key), "/[^a-z0-9_-]/", "-") })

  annotations = {
    description = each.value
  }

  customer_managed_encryption {
    kms_key_name = var.kms_key_id
  }
}

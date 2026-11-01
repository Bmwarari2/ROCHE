# One key ring in London and one symmetric key per purpose, rotated automatically. Each key is
# granted only to the service agents and accounts that use it.

resource "google_kms_key_ring" "this" {
  project  = var.project_id
  name     = var.name_prefix
  location = var.region
}

resource "google_kms_crypto_key" "this" {
  for_each = var.keys

  name            = each.key
  key_ring        = google_kms_key_ring.this.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = var.rotation_period

  version_template {
    algorithm        = "GOOGLE_SYMMETRIC_ENCRYPTION"
    protection_level = "SOFTWARE"
  }

  # A destroyed key makes everything encrypted with it unreadable.
  lifecycle {
    prevent_destroy = true
  }
}

locals {
  grants = merge([
    for key, members in var.keys : { for i, m in members : "${key}|${i}" => { key = key, member = m } }
  ]...)
}

resource "google_kms_crypto_key_iam_member" "use" {
  for_each = local.grants

  crypto_key_id = google_kms_crypto_key.this[each.value.key].id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = each.value.member
}

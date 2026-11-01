output "key_ids" {
  description = "Key resource ids, by purpose."
  value       = { for k, v in google_kms_crypto_key.this : k => v.id }
}

output "key_ring_location" {
  value = google_kms_key_ring.this.location
}

output "rotation_periods" {
  value = { for k, v in google_kms_crypto_key.this : k => v.rotation_period }
}

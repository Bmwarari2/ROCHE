# Partial configuration: the bucket, key, KMS key and locking are supplied at init time with
# `terraform init -backend-config=backend.hcl` (copy backend.hcl.example). Nothing
# account-specific is committed.
terraform {
  backend "s3" {}
}

# Partial configuration: the bucket and prefix (and optionally a KMS key) are supplied at init
# time with `terraform init -backend-config=backend.hcl` (copy backend.hcl.example). The bucket is
# versioned, in europe-west2 and in a separate state project (bootstrap step in infra/README.md);
# GCS locks state natively.
terraform {
  backend "gcs" {}
}

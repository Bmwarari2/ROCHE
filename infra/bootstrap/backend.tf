# Partial configuration: `terraform init -backend-config=backend.hcl` (copy backend.hcl.example).
# Bootstrap state sits in the state project's bucket under its own prefix per environment.
terraform {
  backend "gcs" {}
}

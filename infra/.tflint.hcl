# TFLint configuration for every module and environment under infra/.
# Run from an environment or module directory with: tflint --config "$(git rev-parse --show-toplevel)/infra/.tflint.hcl"

config {
  # Lint the local modules each environment calls, as part of that environment.
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "google" {
  enabled = true
  version = "0.30.0"
  source  = "github.com/terraform-linters/tflint-ruleset-google"
}

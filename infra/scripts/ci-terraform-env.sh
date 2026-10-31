#!/usr/bin/env bash
# Used by .github/workflows/terraform.yml. Writes backend.hcl for an environment and exports
# its TF_VAR_* inputs from GitHub repository variables, leaving optional inputs unset (null)
# rather than empty strings.
#
#   infra/scripts/ci-terraform-env.sh <env>
#
# Reads: GCP_PROJECT_ID, DOMAIN_NAME, STATE_BUCKET (required); STATE_KMS_KEY, DNS_ZONE_NAME,
# ALERT_EMAILS (a JSON list) and BILLING_ACCOUNT_ID, all optional. The safety case version is
# the newest report in docs/clinical-safety/safety-case/ unless SAFETY_CASE_VERSION names one.

set -euo pipefail

ENVIRONMENT="${1:?usage: $0 <env>}"
DIR="$(cd "$(dirname "$0")/../envs/${ENVIRONMENT}" && pwd)"

for name in GCP_PROJECT_ID DOMAIN_NAME STATE_BUCKET; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Repository variable for ${name} is not set for ${ENVIRONMENT}; see infra/README.md."
    exit 1
  fi
done

{
  echo "bucket = \"${STATE_BUCKET}\""
  echo "prefix = \"${ENVIRONMENT}\""
  if [[ -n "${STATE_KMS_KEY:-}" ]]; then
    echo "kms_encryption_key = \"${STATE_KMS_KEY}\""
  fi
} >"${DIR}/backend.hcl"

REPORTS="$(cd "$(dirname "$0")/../../docs/clinical-safety/safety-case" && pwd)"
if [[ -z "${SAFETY_CASE_VERSION:-}" ]]; then
  latest="$(find "${REPORTS}" -maxdepth 1 -name 'safety-case-v*-*.md' -printf '%f\n' | sort -V | tail -n 1)"
  SAFETY_CASE_VERSION="$(sed -E 's/^safety-case-(v[0-9]+\.[0-9]+)-.*$/\1/' <<<"${latest}")"
fi
if ! compgen -G "${REPORTS}/safety-case-${SAFETY_CASE_VERSION}-*.md" >/dev/null; then
  echo "::error::No safety case report for ${SAFETY_CASE_VERSION:-(none)} in docs/clinical-safety/safety-case/."
  exit 1
fi

out="${GITHUB_ENV:-/dev/stdout}"
{
  echo "TF_VAR_project_id=${GCP_PROJECT_ID}"
  echo "TF_VAR_domain_name=${DOMAIN_NAME}"
  echo "TF_VAR_state_bucket_name=${STATE_BUCKET}"
  echo "TF_VAR_safety_case_version=${SAFETY_CASE_VERSION}"
  [[ -n "${DNS_ZONE_NAME:-}" ]] && echo "TF_VAR_dns_zone_name=${DNS_ZONE_NAME}"
  [[ -n "${ALERT_EMAILS:-}" ]] && echo "TF_VAR_alert_email_addresses=${ALERT_EMAILS}"
  [[ -n "${BILLING_ACCOUNT_ID:-}" ]] && echo "TF_VAR_billing_account_id=${BILLING_ACCOUNT_ID}"
  true
} >>"${out}"

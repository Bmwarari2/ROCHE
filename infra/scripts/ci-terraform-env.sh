#!/usr/bin/env bash
# Used by .github/workflows/terraform.yml. Writes backend.hcl for an environment and exports
# its TF_VAR_* inputs from GitHub repository variables, leaving optional inputs unset (null)
# rather than empty strings.
#
#   infra/scripts/ci-terraform-env.sh <env>
#
# Reads: AWS_ACCOUNT_ID, DOMAIN_NAME, STATE_BUCKET (required); STATE_KMS_KEY_ARN,
# ROUTE53_ZONE_ID, ALERT_EMAILS and BUDGET_EMAILS (JSON lists), all optional. The safety case
# version is the newest report in docs/clinical-safety/safety-case/ unless SAFETY_CASE_VERSION
# names one.

set -euo pipefail

ENVIRONMENT="${1:?usage: $0 <env>}"
DIR="$(cd "$(dirname "$0")/../envs/${ENVIRONMENT}" && pwd)"

for name in AWS_ACCOUNT_ID DOMAIN_NAME STATE_BUCKET; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error::Repository variable for ${name} is not set for ${ENVIRONMENT}; see infra/README.md."
    exit 1
  fi
done

{
  echo "bucket       = \"${STATE_BUCKET}\""
  echo "key          = \"${ENVIRONMENT}/terraform.tfstate\""
  echo "region       = \"eu-west-2\""
  echo "encrypt      = true"
  echo "use_lockfile = true"
  if [[ -n "${STATE_KMS_KEY_ARN:-}" ]]; then
    echo "kms_key_id   = \"${STATE_KMS_KEY_ARN}\""
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
  echo "TF_VAR_aws_account_id=${AWS_ACCOUNT_ID}"
  echo "TF_VAR_domain_name=${DOMAIN_NAME}"
  echo "TF_VAR_state_bucket_name=${STATE_BUCKET}"
  echo "TF_VAR_safety_case_version=${SAFETY_CASE_VERSION}"
  [[ -n "${STATE_KMS_KEY_ARN:-}" ]] && echo "TF_VAR_state_kms_key_arn=${STATE_KMS_KEY_ARN}"
  [[ -n "${ROUTE53_ZONE_ID:-}" ]] && echo "TF_VAR_route53_zone_id=${ROUTE53_ZONE_ID}"
  [[ -n "${ALERT_EMAILS:-}" ]] && echo "TF_VAR_alert_email_addresses=${ALERT_EMAILS}"
  [[ -n "${BUDGET_EMAILS:-}" ]] && echo "TF_VAR_budget_email_addresses=${BUDGET_EMAILS}"
  true
} >>"${out}"

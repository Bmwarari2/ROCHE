#!/usr/bin/env bash
# Generates values for the Secrets Manager secrets the Harbour stack creates, inside AWS, so no
# password ever passes through Terraform state, plan output, the terminal or shell history.
#
#   infra/scripts/seed-secrets.sh <dev|staging|prod>                  fill every empty secret
#   infra/scripts/seed-secrets.sh <dev|staging|prod> --rotate <name>  new value for one secret
#   infra/scripts/seed-secrets.sh <dev|staging|prod> --refresh-urls   rewrite db/* url keys
#
# <name> is the part after "harbour-<env>/", for example db/harbour_app or api.
# Idempotent: without --rotate, secrets that already have a value are left alone.
# db/* secrets hold {username, password, url}; url points at the current RDS endpoint with
# sslmode=verify-full. Run --refresh-urls if a database is ever restored to a new instance.
# After rotating a db/* secret, run the migrate task (db:bootstrap re-applies role passwords)
# and then force a new deployment of the services that use it. Rotating api replaces the
# PowerSync signing key: keep the old key in the JWKS until issued tokens have expired.
#
# Needs: AWS CLI v2 with credentials for the environment's account (an administrator; the CI
# roles cannot read secret values), openssl and jq.

set -euo pipefail

readonly REGION="eu-west-2"

usage() {
  echo "Usage: $0 <dev|staging|prod> [--rotate <secret-name> | --refresh-urls]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
ENVIRONMENT="$1"
shift
case "${ENVIRONMENT}" in dev | staging | prod) ;; *) usage ;; esac

ROTATE=""
REFRESH_URLS=false
if [[ $# -gt 0 ]]; then
  case "$1" in
    --rotate)
      [[ $# -eq 2 ]] || usage
      ROTATE="$2"
      ;;
    --refresh-urls)
      [[ $# -eq 1 ]] || usage
      REFRESH_URLS=true
      ;;
    *) usage ;;
  esac
fi

for tool in aws openssl jq; do
  command -v "${tool}" >/dev/null || { echo "Missing required tool: ${tool}" >&2; exit 1; }
done

PREFIX="harbour-${ENVIRONMENT}"
WORKDIR="$(mktemp -d)"
chmod 700 "${WORKDIR}"
trap 'rm -rf "${WORKDIR}"' EXIT
umask 077

db_endpoint() {
  aws rds describe-db-instances --region "${REGION}" --db-instance-identifier "$1" \
    --query 'DBInstances[0].Endpoint.Address' --output text
}

# Role secrets on the bucket-storage instance; every other db/* role is on the main database.
db_target() {
  case "$1" in
    powersync_storage) echo "${PREFIX}-sync-storage powersync_storage" ;;
    *) echo "${PREFIX}-main harbour" ;;
  esac
}

db_url() {
  local role="$1" password="$2" instance database host
  read -r instance database <<<"$(db_target "${role}")"
  host="$(db_endpoint "${instance}")"
  printf 'postgres://%s:%s@%s:5432/%s?sslmode=verify-full' "${role}" "${password}" "${host}" "${database}"
}

random_password() {
  # 40 characters from [A-Za-z0-9]: no quoting problems in connection strings or SQL.
  openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c 40
}

# Secret values reach jq through the environment, never through command-line arguments,
# which other users on the machine could read from the process list.
secret_json() {
  local name="$1"
  case "${name}" in
    db/*)
      local role="${name#db/}" password
      password="$(random_password)"
      ROLE="${role}" PASSWORD="${password}" URL="$(db_url "${role}" "${password}")" \
        jq -n '{username: env.ROLE, password: env.PASSWORD, url: env.URL}'
      ;;
    api)
      # RS256 key the API signs PowerSync JWTs with; the API publishes the public half at
      # /v1/sync/jwks under the key ID below.
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${WORKDIR}/sync-key.pem" 2>/dev/null
      # evidence_link_secret: the HMAC key for evidence pack codes and link sessions (ADR-0050).
      # elearning_launch_secret: the HMAC key for e-learning launch tokens (ADR-0093).
      AUTH_SECRET="$(openssl rand -base64 48)" EVIDENCE_SECRET="$(openssl rand -base64 48)" \
        ELEARNING_SECRET="$(openssl rand -base64 48)" \
        KID="harbour-${ENVIRONMENT}-$(date -u +%Y%m%d%H%M%S)" \
        jq -n --rawfile k "${WORKDIR}/sync-key.pem" \
        '{auth_secret: env.AUTH_SECRET, evidence_link_secret: env.EVIDENCE_SECRET, elearning_launch_secret: env.ELEARNING_SECRET, sync_signing_key_pem: $k, sync_signing_key_id: env.KID}'
      rm -f "${WORKDIR}/sync-key.pem"
      ;;
    powersync/api-token)
      TOKEN="$(random_password)" jq -n '{token: env.TOKEN}'
      ;;
    flagsmith)
      DJANGO_KEY="$(random_password)$(random_password)" PASSWORD="$(random_password)" \
        jq -n '{django_secret_key: env.DJANGO_KEY, database_password: env.PASSWORD}'
      ;;
    *)
      echo "No generator for secret ${name}" >&2
      return 1
      ;;
  esac
}

has_value() {
  local stages
  stages="$(aws secretsmanager describe-secret --region "${REGION}" --secret-id "$1" \
    --query 'VersionIdsToStages' --output json)"
  [[ "${stages}" != "null" && "${stages}" != "{}" ]]
}

put_value() {
  local id="$1" name="$2"
  secret_json "${name}" >"${WORKDIR}/value.json"
  aws secretsmanager put-secret-value --region "${REGION}" --secret-id "${id}" \
    --secret-string "file://${WORKDIR}/value.json" --output text --query 'VersionId' >/dev/null
  rm -f "${WORKDIR}/value.json"
}

mapfile -t SECRET_IDS < <(aws secretsmanager list-secrets --region "${REGION}" \
  --filters "Key=name,Values=${PREFIX}/" --query 'SecretList[].Name' --output text | tr '\t' '\n' | sed '/^$/d')

if [[ ${#SECRET_IDS[@]} -eq 0 ]]; then
  echo "No secrets named ${PREFIX}/... found. Apply infra/envs/${ENVIRONMENT} first." >&2
  exit 1
fi

refresh_url() {
  local id="$1" name="$2" password
  aws secretsmanager get-secret-value --region "${REGION}" --secret-id "${id}" \
    --query 'SecretString' --output text >"${WORKDIR}/current.json"
  password="$(jq -r '.password' "${WORKDIR}/current.json")"
  URL="$(db_url "${name#db/}" "${password}")" jq '.url = env.URL' "${WORKDIR}/current.json" >"${WORKDIR}/value.json"
  aws secretsmanager put-secret-value --region "${REGION}" --secret-id "${id}" \
    --secret-string "file://${WORKDIR}/value.json" --output text --query 'VersionId' >/dev/null
  rm -f "${WORKDIR}/current.json" "${WORKDIR}/value.json"
}

for id in "${SECRET_IDS[@]}"; do
  name="${id#"${PREFIX}/"}"
  if [[ "${REFRESH_URLS}" == true ]]; then
    if [[ "${name}" == db/* ]] && has_value "${id}"; then
      refresh_url "${id}" "${name}"
      echo "Refreshed url in ${id}"
    fi
  elif [[ -n "${ROTATE}" ]]; then
    [[ "${name}" == "${ROTATE}" ]] || continue
    put_value "${id}" "${name}"
    echo "Rotated ${id}"
  elif has_value "${id}"; then
    echo "Kept ${id} (already has a value)"
  else
    put_value "${id}" "${name}"
    echo "Seeded ${id}"
  fi
done

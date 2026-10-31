#!/usr/bin/env bash
# Generates values for the Secret Manager secrets the Harbour stack creates, inside Google Cloud,
# so no password ever passes through Terraform state, plan output, the terminal, shell history or
# a command line (values travel in files under a private temporary directory).
#
#   infra/scripts/seed-secrets.sh <dev|staging|prod>                  fill every empty secret
#   infra/scripts/seed-secrets.sh <dev|staging|prod> --rotate <name>  new value for one secret
#   infra/scripts/seed-secrets.sh <dev|staging|prod> --refresh-urls   rewrite db-*-url secrets
#
# <name> is the part after "harbour-<env>-", for example db-harbour_app-password or
# api-auth-secret. Idempotent: without --rotate, secrets that already have a value are left alone.
# A database role has two secrets, its password and a ready-made URL (sslmode=verify-ca against
# the mounted Cloud SQL server CA); rotating either writes both. The postgres user's password on
# each instance (db-admin-password, db-sync-admin-password) is set through the Cloud SQL Admin API.
# After rotating a db-* secret, execute the migrate job (db:bootstrap re-applies role passwords)
# and then deploy a new revision of the services that use it. Rotating api-sync-signing-key-pem
# replaces the PowerSync signing key: keep the old key in the JWKS until issued tokens expire.
#
# Needs: gcloud (signed in as an administrator of the environment's project; the CI accounts
# cannot read secret values), curl, openssl and jq. Set GCP_PROJECT_ID.

set -euo pipefail

readonly REGION="europe-west2"

usage() {
  echo "Usage: GCP_PROJECT_ID=<project> $0 <dev|staging|prod> [--rotate <secret-name> | --refresh-urls]" >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
ENVIRONMENT="$1"
shift
case "${ENVIRONMENT}" in dev | staging | prod) ;; *) usage ;; esac
PROJECT="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID to the ${ENVIRONMENT} project}"

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

for tool in gcloud curl openssl jq; do
  command -v "${tool}" >/dev/null || { echo "Missing required tool: ${tool}" >&2; exit 1; }
done

PREFIX="harbour-${ENVIRONMENT}"
WORKDIR="$(mktemp -d)"
chmod 700 "${WORKDIR}"
trap 'rm -rf "${WORKDIR}"' EXIT
umask 077

readonly CA_FILE="/secrets/cloudsql/server-ca.pem"
readonly ROLES=(harbour_owner harbour_app harbour_auth harbour_sync harbour_operator harbour_worker powersync_storage)

secret_id() { echo "${PREFIX}-$1"; }

has_value() {
  [[ -n "$(gcloud secrets versions list "$(secret_id "$1")" --location="${REGION}" --project="${PROJECT}" \
    --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]]
}

exists() {
  gcloud secrets describe "$(secret_id "$1")" --location="${REGION}" --project="${PROJECT}" >/dev/null 2>&1
}

# Adds the file's contents as the secret's new version.
put_file() {
  gcloud secrets versions add "$(secret_id "$1")" --location="${REGION}" --project="${PROJECT}" \
    --data-file="$2" --format='value(name)' >/dev/null
  rm -f "$2"
}

read_value() {
  gcloud secrets versions access latest --secret="$(secret_id "$1")" --location="${REGION}" \
    --project="${PROJECT}" --out-file="$2"
}

random_password() {
  # 40 characters from [A-Za-z0-9]: no quoting problems in connection strings or SQL.
  openssl rand -base64 96 | tr -dc 'A-Za-z0-9' | head -c 40
}

instance_of() {
  case "$1" in
    powersync_storage) echo "${PREFIX}-sync-storage powersync_storage" ;;
    *) echo "${PREFIX}-main harbour" ;;
  esac
}

private_ip() {
  gcloud sql instances describe "$1" --project="${PROJECT}" \
    --format='value(ipAddresses[0].ipAddress)'
}

# Writes db-<role>-url from the password in the given file.
write_url() {
  local role="$1" password_file="$2" instance database host
  read -r instance database <<<"$(instance_of "${role}")"
  host="$(private_ip "${instance}")"
  ROLE="${role}" HOST="${host}" DB="${database}" CA="${CA_FILE}" \
    jq -rn --rawfile p "${password_file}" \
    '"postgres://\(env.ROLE):\($p)@\(env.HOST):5432/\(env.DB)?sslmode=verify-ca&sslrootcert=\(env.CA)"' \
    | tr -d '\n' >"${WORKDIR}/url"
  put_file "db-${role}-url" "${WORKDIR}/url"
}

seed_role() {
  local role="$1"
  random_password >"${WORKDIR}/password"
  cp "${WORKDIR}/password" "${WORKDIR}/password.url"
  put_file "db-${role}-password" "${WORKDIR}/password"
  write_url "${role}" "${WORKDIR}/password.url"
  rm -f "${WORKDIR}/password.url"
}

# The postgres user's password, through the Cloud SQL Admin API: the token and the password
# travel in files (curl -H @file and --data @file), never on a command line.
set_admin_password() {
  local name="$1" instance="$2"
  random_password >"${WORKDIR}/admin"
  jq -n --rawfile p "${WORKDIR}/admin" '{name: "postgres", password: $p}' >"${WORKDIR}/body.json"
  printf 'Authorization: Bearer %s\n' "$(gcloud auth print-access-token)" >"${WORKDIR}/auth"
  curl -sSf -X PUT -H @"${WORKDIR}/auth" -H 'Content-Type: application/json' \
    --data @"${WORKDIR}/body.json" \
    "https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${instance}/users?name=postgres" >/dev/null
  rm -f "${WORKDIR}/auth" "${WORKDIR}/body.json"
  put_file "${name}" "${WORKDIR}/admin"
}

seed_server_ca() {
  : >"${WORKDIR}/ca.pem"
  for instance in "${PREFIX}-main" "${PREFIX}-sync-storage"; do
    gcloud sql instances describe "${instance}" --project="${PROJECT}" \
      --format='value(serverCaCert.cert)' >>"${WORKDIR}/ca.pem"
  done
  put_file db-server-ca "${WORKDIR}/ca.pem"
}

seed() {
  local name="$1"
  case "${name}" in
    db-server-ca) seed_server_ca ;;
    db-admin-password) set_admin_password "${name}" "${PREFIX}-main" ;;
    db-sync-admin-password) set_admin_password "${name}" "${PREFIX}-sync-storage" ;;
    db-*-password | db-*-url)
      local role="${name#db-}"
      seed_role "${role%-*}"
      ;;
    api-auth-secret | api-evidence-link-secret)
      openssl rand -base64 48 | tr -d '\n' >"${WORKDIR}/value"
      put_file "${name}" "${WORKDIR}/value"
      ;;
    api-sync-signing-key-pem | api-sync-signing-key-id)
      # RS256 key the API signs PowerSync tokens with; the API publishes the public half at
      # /v1/sync/jwks under the key ID.
      openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "${WORKDIR}/sync-key.pem" 2>/dev/null
      printf 'harbour-%s-%s' "${ENVIRONMENT}" "$(date -u +%Y%m%d%H%M%S)" >"${WORKDIR}/kid"
      put_file api-sync-signing-key-pem "${WORKDIR}/sync-key.pem"
      put_file api-sync-signing-key-id "${WORKDIR}/kid"
      ;;
    powersync-api-token | flagsmith-database-password)
      random_password >"${WORKDIR}/value"
      put_file "${name}" "${WORKDIR}/value"
      ;;
    flagsmith-django-secret-key)
      { random_password; random_password; } | tr -d '\n' >"${WORKDIR}/value"
      put_file "${name}" "${WORKDIR}/value"
      ;;
    smtp-user | smtp-password)
      echo "${name} comes from the SMTP provider, once one is chosen: add it with" >&2
      echo "  gcloud secrets versions add $(secret_id "${name}") --location=${REGION} --project=${PROJECT} --data-file=<file>" >&2
      ;;
    *)
      echo "No generator for secret ${name}" >&2
      return 1
      ;;
  esac
}

mapfile -t NAMES < <(gcloud secrets list --location="${REGION}" --project="${PROJECT}" \
  --filter="name~/secrets/${PREFIX}-" --format='value(name.basename())' | sed "s/^${PREFIX}-//" | sort)

if [[ ${#NAMES[@]} -eq 0 ]]; then
  echo "No secrets named ${PREFIX}-... found. Apply infra/envs/${ENVIRONMENT} first." >&2
  exit 1
fi

if [[ "${REFRESH_URLS}" == true ]]; then
  for role in "${ROLES[@]}"; do
    if has_value "db-${role}-password"; then
      read_value "db-${role}-password" "${WORKDIR}/password"
      write_url "${role}" "${WORKDIR}/password"
      rm -f "${WORKDIR}/password"
      echo "Refreshed $(secret_id "db-${role}-url")"
    fi
  done
  exit 0
fi

if [[ -n "${ROTATE}" ]]; then
  exists "${ROTATE}" || { echo "No secret $(secret_id "${ROTATE}")" >&2; exit 1; }
  seed "${ROTATE}"
  echo "Rotated $(secret_id "${ROTATE}")"
  exit 0
fi

# The server CA first: every URL names it.
for name in db-server-ca "${NAMES[@]}"; do
  if has_value "${name}"; then
    echo "Kept $(secret_id "${name}") (already has a value)"
  else
    seed "${name}"
    echo "Filled $(secret_id "${name}")"
  fi
done

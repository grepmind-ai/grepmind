#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "Preflight failed: $*" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "$1 is required"
}

require_var() {
  local name="$1"
  local value="${!name:-}"
  [[ -n "$value" ]] || fail "$name must be set"
}

require_mode() {
  case "${GREPMIND_DEPLOYMENT_MODE:-}" in
    bundled|external) ;;
    *) fail "GREPMIND_DEPLOYMENT_MODE must be bundled or external" ;;
  esac
}

require_proxy() {
  case "${GREPMIND_REVERSE_PROXY:-none}" in
    none|traefik) ;;
    *) fail "GREPMIND_REVERSE_PROXY must be none or traefik" ;;
  esac
}

check_config_placeholders() {
  require_file config.yml

  local placeholders=(
    "http://your.server.public.ip:3847"
    "https://<clerk-frontend-api>"
    "<clerk-cli-oauth-client-id>"
    "publishableKey: \"\""
    "<postgres-host>"
    "<s3-endpoint>"
    "<s3-bucket>"
  )

  for placeholder in "${placeholders[@]}"; do
    if grep -Fq "$placeholder" config.yml; then
      fail "config.yml still contains placeholder for ${placeholder}"
    fi
  done
}

select_compose_files() {
  compose_files=(-f docker-compose.yml)

  if [[ "$GREPMIND_DEPLOYMENT_MODE" == "bundled" ]]; then
    compose_files+=(-f docker-compose.bundled.yml)
  else
    compose_files+=(-f docker-compose.external.yml)
  fi

  if [[ "${GREPMIND_REVERSE_PROXY:-none}" == "traefik" ]]; then
    compose_files+=(-f docker-compose.traefik.yml)
  else
    compose_files+=(-f docker-compose.direct.yml)
  fi
}

require_file .env
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${GREPMIND_DEPLOYMENT_MODE:=bundled}"
: "${GREPMIND_REVERSE_PROXY:=none}"

require_mode
require_proxy
require_var CLERK_SECRET_KEY
require_var VOYAGE_API_KEY
check_config_placeholders

if [[ "$GREPMIND_DEPLOYMENT_MODE" == "bundled" ]]; then
  require_file .env.grepmind-generated
  set -a
  # shellcheck disable=SC1091
  . ./.env.grepmind-generated
  set +a
else
  require_var DATABASE_URL
  require_var GREPMIND_S3_ACCESS_KEY
  require_var GREPMIND_S3_SECRET_KEY
fi

if [[ "$GREPMIND_REVERSE_PROXY" == "traefik" ]]; then
  require_var GREPMIND_PUBLIC_HOST
  require_var TRAEFIK_ACME_EMAIL
fi

select_compose_files

docker compose "${compose_files[@]}" pull
docker compose "${compose_files[@]}" run --rm grepmind-migrate
docker compose "${compose_files[@]}" up -d
docker compose "${compose_files[@]}" ps

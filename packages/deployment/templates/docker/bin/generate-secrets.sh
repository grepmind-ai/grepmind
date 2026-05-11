#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

force=false
if [[ "${1:-}" == "--force" ]]; then
  force=true
elif [[ $# -gt 0 ]]; then
  echo "Unknown option: $1" >&2
  exit 1
fi

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

deployment_mode="${GREPMIND_DEPLOYMENT_MODE:-bundled}"
if [[ "$deployment_mode" == "external" ]]; then
  echo "GREPMIND_DEPLOYMENT_MODE is external; bundled secrets are not generated." >&2
  exit 1
fi

if [[ "$deployment_mode" != "bundled" ]]; then
  echo "GREPMIND_DEPLOYMENT_MODE must be bundled or external." >&2
  exit 1
fi

if [[ -e .env.grepmind-generated && "$force" != "true" ]]; then
  echo ".env.grepmind-generated already exists. Re-run with --force only before MinIO/Postgres data has been provisioned." >&2
  exit 1
fi

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 36 | tr -d '\n'
    return
  fi

  node -e "process.stdout.write(require('node:crypto').randomBytes(36).toString('base64'))"
}

quote_shell() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

postgres_password="$(random_secret)"
s3_access_key="grepmind_$(random_secret | tr -dc 'A-Za-z0-9' | head -c 24)"
s3_secret_key="$(random_secret)"
minio_root_user="minio_$(random_secret | tr -dc 'A-Za-z0-9' | head -c 18)"
minio_root_password="$(random_secret)"
database_url="postgresql://grepmind:${postgres_password}@postgres:5432/grepmind"

tmp_file="$(mktemp .env.grepmind-generated.XXXXXX)"
chmod 600 "$tmp_file"
{
  printf "POSTGRES_PASSWORD=%s\n" "$(quote_shell "$postgres_password")"
  printf "DATABASE_URL=%s\n" "$(quote_shell "$database_url")"
  printf "GREPMIND_S3_ACCESS_KEY=%s\n" "$(quote_shell "$s3_access_key")"
  printf "GREPMIND_S3_SECRET_KEY=%s\n" "$(quote_shell "$s3_secret_key")"
  printf "MINIO_ROOT_USER=%s\n" "$(quote_shell "$minio_root_user")"
  printf "MINIO_ROOT_PASSWORD=%s\n" "$(quote_shell "$minio_root_password")"
} > "$tmp_file"
mv "$tmp_file" .env.grepmind-generated
chmod 600 .env.grepmind-generated

echo "Generated .env.grepmind-generated with:"
echo "  POSTGRES_PASSWORD"
echo "  DATABASE_URL"
echo "  GREPMIND_S3_ACCESS_KEY"
echo "  GREPMIND_S3_SECRET_KEY"
echo "  MINIO_ROOT_USER"
echo "  MINIO_ROOT_PASSWORD"

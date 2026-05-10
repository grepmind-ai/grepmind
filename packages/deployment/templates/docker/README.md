# Grepmind Docker Compose Deployment

This directory is the generated Docker Compose deployment template for a single Linux VM.

The runtime contract is one application service:

- image: `ghcr.io/zaytra-labs/grepmind-app:${GREPMIND_TAG:-latest}`
- service: `grepmind-app`
- internal HTTP port: `3847`
- healthcheck: `/api/health`
- config: `./config.yml` mounted at `/etc/grepmind/config.yml`

## Quick Start: Bundled PostgreSQL and MinIO

```sh
cp .env.example .env
./bin/generate-secrets.sh
# edit .env and config.yml
./bin/start-grepmind.sh
```

Before startup, edit `.env` and `config.yml`.

Required `.env` values:

- `CLERK_SECRET_KEY`
- `VOYAGE_API_KEY`

Required `config.yml` values:

- `app.publicBaseUrl`
- `agentAuth.frontendApiUrl`
- `agentAuth.cliOAuthClientId`
- `clerk.publishableKey`

Bundled mode starts local `postgres`, `minio`, and `minio-init` services. The generated `.env.grepmind-generated` file contains only local service secrets and is required only when `GREPMIND_DEPLOYMENT_MODE='bundled'`.

## External PostgreSQL and S3-Compatible Storage

Use external mode when PostgreSQL and S3-compatible storage already exist.

```sh
cp .env.example .env
cp config.external.yml.example config.yml
# edit .env and config.yml
./bin/start-grepmind.sh
```

Set these values in `.env`:

```sh
GREPMIND_DEPLOYMENT_MODE='external'
DATABASE_URL='postgresql://grepmind:password@db.example.internal:5432/grepmind'
GREPMIND_S3_ACCESS_KEY='...'
GREPMIND_S3_SECRET_KEY='...'
CLERK_SECRET_KEY='...'
VOYAGE_API_KEY='...'
```

Set the external database and S3 endpoint, port, SSL flag, bucket, and prefix in `config.yml`.

Grepmind does not create or manage an external database, database user, S3 bucket, bucket policy, IAM user, or access keys. Those resources must already exist and be reachable from the Docker Compose network. The provided S3 credentials must have read/write access to the configured bucket and prefix.

Do not run `generate-secrets.sh` for external mode. If `.env` sets `GREPMIND_DEPLOYMENT_MODE='external'`, the script exits before writing `.env.grepmind-generated`.

## Direct HTTP Mode

Direct mode is the default:

```sh
GREPMIND_REVERSE_PROXY='none'
GREPMIND_HTTP_PORT='3847'
```

The scripts include `docker-compose.direct.yml`, which publishes:

```txt
${GREPMIND_HTTP_PORT:-3847}:3847
```

## Traefik HTTPS Mode

Traefik mode is an optional overlay for VM deployments with public DNS pointing at the host.

Set:

```sh
GREPMIND_REVERSE_PROXY='traefik'
GREPMIND_PUBLIC_HOST='grepmind.example.com'
TRAEFIK_ACME_EMAIL='admin@example.com'
GREPMIND_HTTP_PORT='80'
GREPMIND_HTTPS_PORT='443'
```

Set `app.publicBaseUrl` in `config.yml` to:

```txt
https://grepmind.example.com
```

The scripts include `docker-compose.traefik.yml` instead of `docker-compose.direct.yml`. Traefik publishes `80` and `443`, redirects HTTP to HTTPS, obtains ACME HTTP-01 certificates, and forwards to `grepmind-app:3847` on the internal Compose network. `grepmind-app` is not published directly to the host in this mode.

## Compose Files

The scripts select compose files from `.env`.

Bundled direct:

```sh
docker compose -f docker-compose.yml -f docker-compose.bundled.yml -f docker-compose.direct.yml ...
```

External direct:

```sh
docker compose -f docker-compose.yml -f docker-compose.external.yml -f docker-compose.direct.yml ...
```

Bundled Traefik:

```sh
docker compose -f docker-compose.yml -f docker-compose.bundled.yml -f docker-compose.traefik.yml ...
```

External Traefik:

```sh
docker compose -f docker-compose.yml -f docker-compose.external.yml -f docker-compose.traefik.yml ...
```

Users do not need to set `COMPOSE_FILE`.

## Migrations

`./bin/start-grepmind.sh` and `./bin/update-grepmind-images.sh` run the explicit one-shot `grepmind-migrate` service before starting or updating the app:

```sh
docker compose ... pull
docker compose ... run --rm grepmind-migrate
docker compose ... up -d
docker compose ... ps
```

The app startup itself is not responsible for schema migrations.

## Generated Secrets

`./bin/generate-secrets.sh` writes `.env.grepmind-generated` with mode `0600` and prints variable names only.

It does not overwrite an existing generated file unless `--force` is passed. If bundled MinIO has already been provisioned, rotating `GREPMIND_S3_ACCESS_KEY` or `GREPMIND_S3_SECRET_KEY` with `--force` requires recreating the MinIO volume or manually updating the MinIO user secret.

## Systemd

The supported systemd install path is `/opt/grepmind`. If you deploy to a different path, edit the units before installing them.

The units assume Docker Compose is available through `/usr/bin/docker`.

```sh
sudo mkdir -p /opt/grepmind
sudo cp -a . /opt/grepmind/
sudo cp /opt/grepmind/systemd/grepmind-app.service /etc/systemd/system/
sudo cp /opt/grepmind/systemd/grepmind-images.service /etc/systemd/system/
sudo cp /opt/grepmind/systemd/grepmind-images.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now grepmind-app.service
sudo systemctl enable --now grepmind-images.timer
```

Inspect the service:

```sh
sudo systemctl status grepmind-app.service
sudo journalctl -u grepmind-app.service -f
```

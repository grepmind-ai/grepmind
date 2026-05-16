# Grepmind Kubernetes Beta

This template is the controlled Kubernetes beta rollout surface for the
Grepmind app/worker split. It is not a general production HA template.

Use this directory with a phase 09-compatible Grepmind app image from the same
release or an explicitly verified revision. Do not apply this template to an
older image unless smoke verification proves that the image implements:

- unauthenticated `GET /api/ready`;
- role-aware `GET /api/health`;
- explicit app and worker commands using `node packages/app/dist/index.js`;
- `npm run db:migrate`;
- `GREPMIND_DEPLOYMENT_CONTEXT=beta`;
- `pubsub.transport=redis-compatible` with `GREPMIND_REDIS_URL`;
- beta DB pool env vars required for shared budget validation;
- `GREPMIND_SERVER_INSTANCE_ID` from Kubernetes pod identity.

Record the image tag and runtime revision before rollout:

```sh
export GREPMIND_NAMESPACE=grepmind-beta
export GREPMIND_IMAGE_TAG=<phase-09-image-tag>
export GREPMIND_RUNTIME_REVISION=<phase-09-runtime-revision>
```

Replace the `<phase-09-image-tag>` and `<phase-09-runtime-revision>`
placeholders in `migration-job.yaml`, `app-deployment.yaml` and
`worker-deployment.yaml`. Keep the image/template pair together for rollback.

## Files

- `namespace.yaml` creates the beta namespace.
- `configmap.yaml` mounts `/etc/grepmind/config.yml`.
- `secret.example.yaml` documents required secret keys only.
- `migration-job.yaml` runs `npm run db:migrate`.
- `worker-deployment.yaml` runs `node packages/app/dist/index.js --config
  /etc/grepmind/config.yml --host 0.0.0.0 --port 3848` for the internal
  worker role.
- `app-deployment.yaml` runs `node packages/app/dist/index.js --config
  /etc/grepmind/config.yml --host 0.0.0.0 --port 3847` for two public app
  replicas.
- `app-service.yaml` and `app-ingress.yaml` expose only app traffic.
- `pdb.yaml` keeps at least one app pod available during voluntary disruption.
- `bin/verify-launch-gate.sh` verifies required staging evidence and live
  cluster state before launch approval.
- `kustomization.yaml` is for static review only.

Do not use `kubectl apply -k .` as the beta rollout command. The rollout order
must keep migration completion ahead of app/worker Deployment rollout.

## Required Edits

Before applying manifests, replace these placeholders:

- `<beta-host>`;
- `<ingress-class>`;
- `<environment>`;
- `<clerk-publishable-key>`;
- `<clerk-frontend-api-url>`;
- `<clerk-cli-oauth-client-id>`;
- `<s3-endpoint>`;
- `<bucket>`;
- `<neon-connection-cap>`;
- `<phase-09-image-tag>`;
- `<phase-09-runtime-revision>`.

Do not add `app.serverInstanceId` to `config.yml`. App and worker identities are
set from Kubernetes Downward API with `metadata.name`.

## Secrets

`secret.example.yaml` is a schema example. Do not apply it with real literals
checked into Git. Create `grepmind-runtime-secrets` through your cluster secret
manager, External Secrets, Sealed Secrets, or an equivalent platform flow.

Required keys:

- `DATABASE_URL`;
- `CLERK_SECRET_KEY`;
- `VOYAGE_API_KEY`;
- `GREPMIND_REDIS_URL`;
- `GREPMIND_S3_ACCESS_KEY`;
- `GREPMIND_S3_SECRET_KEY`.

## DB Pool Budget

Beta defaults:

```text
app replicas = 2
worker replicas = 1
GREPMIND_APP_DB_POOL_MAX = 5
GREPMIND_WORKER_DB_POOL_MAX = 5
GREPMIND_DBOS_DB_POOL_MAX = 5
GREPMIND_DB_CONNECTION_RESERVED = 5
GREPMIND_DB_CONNECTION_HEADROOM_PERCENT = 20
```

Set `GREPMIND_APP_DB_POOL_MAX`, `GREPMIND_WORKER_DB_POOL_MAX` and
`GREPMIND_DBOS_DB_POOL_MAX` in both the app and worker Deployments. Each role
uses only its own pool values at runtime, but every beta pod validates the same
cluster-wide PostgreSQL connection budget before startup. Keep these values in
sync across both manifests.

Formula:

```text
total_runtime_connections =
  appReplicas * GREPMIND_APP_DB_POOL_MAX
  + workerReplicas * (GREPMIND_WORKER_DB_POOL_MAX + GREPMIND_DBOS_DB_POOL_MAX)
  + GREPMIND_DB_CONNECTION_RESERVED

allowed_connections =
  floor(GREPMIND_NEON_CONNECTION_CAP
    * (1 - GREPMIND_DB_CONNECTION_HEADROOM_PERCENT / 100))
```

Default total:

```text
2 * 5 + 1 * (5 + 5) + 5 = 25 PostgreSQL connections before headroom cap check
```

Set `GREPMIND_NEON_CONNECTION_CAP` to the selected Neon pooler/database limit
and verify `25 <= allowed_connections` before rollout. HPA is intentionally not
included until pool/cap automation exists.

## Ordered Rollout

Run these commands explicitly. Replace `<namespace>` with `grepmind-beta` or
your selected namespace.

```sh
kubectl apply -f namespace.yaml
kubectl -n <namespace> apply -f configmap.yaml
kubectl -n <namespace> apply -f <real-secret-or-external-secret-manifest>
```

Confirm that the migration is additive/backward-compatible with the currently
serving app/worker version. If it is not, drain or enter maintenance mode before
running the migration Job.

```sh
kubectl -n <namespace> apply -f migration-job.yaml
kubectl -n <namespace> wait --for=condition=complete job/grepmind-migrate --timeout=300s
```

Only after migration completion:

```sh
kubectl -n <namespace> apply -f worker-deployment.yaml
kubectl -n <namespace> rollout status deployment/grepmind-worker --timeout=300s

kubectl -n <namespace> apply -f app-service.yaml -f app-deployment.yaml -f app-ingress.yaml -f pdb.yaml
kubectl -n <namespace> rollout status deployment/grepmind-app --timeout=300s
kubectl -n <namespace> get pods -l app.kubernetes.io/name=grepmind -o wide
```

The app Deployment uses `RollingUpdate` with `maxUnavailable: 0` and
`maxSurge: 1`. The worker Deployment uses `Recreate` with one beta replica.

## Probes

Both app and worker use:

- startup/liveness: `GET /api/health`;
- readiness: `GET /api/ready`.

`/api/health` is diagnostics-oriented and should stay secret-safe.
`/api/ready` is compact and should return 503 until the pod can serve its role.
Redis/provider degradation should remove readiness where required; it should
not cause liveness restarts by itself.

## Filesystem Policy

No PVC is mounted in beta. `/tmp` is an `emptyDir`; canonical GitHub snapshots
use disposable temp paths and recover through durable PostgreSQL/DBOS state.
`/var/lib/grepmind/repos` may exist in the image for self-hosted compatibility,
but it is not a Kubernetes beta state path.

Binding-private sync is disabled by default with
`GREPMIND_PRIVATE_SYNC_MODE=disabled`. Do not enable `server-local` in generic
Kubernetes beta without a separate shared-path design and pod deletion check.

## Verification

Health inspection:

```sh
kubectl -n <namespace> exec deploy/grepmind-app -- \
  node -e "fetch('http://127.0.0.1:3847/api/health').then(r=>r.json()).then(x=>console.log(JSON.stringify(x,null,2)))"

kubectl -n <namespace> exec deploy/grepmind-worker -- \
  node -e "fetch('http://127.0.0.1:3848/api/health').then(r=>r.json()).then(x=>console.log(JSON.stringify(x,null,2)))"
```

Launch gate:

- app has two ready replicas;
- worker has one ready replica;
- Ingress routes only to `grepmind-app`;
- `/api/health` shows `deploymentContext: beta` and `redis-compatible`;
- `/api/ready` drives Kubernetes readiness;
- private sync diagnostics show `mode: disabled`;
- pod deletion during canonical indexing has been verified;
- rollback runbook has been executed once in staging.

The launch gate is not complete until the verifier passes with evidence
references for phases 04-08 and the required staging drills:

```sh
GREPMIND_NAMESPACE=<namespace> \
GREPMIND_IMAGE_TAG=<phase-09-image-tag> \
GREPMIND_RUNTIME_REVISION=<phase-09-runtime-revision> \
GREPMIND_PHASE_04_ACCEPTANCE_REF=<ref> \
GREPMIND_PHASE_05_ACCEPTANCE_REF=<ref> \
GREPMIND_PHASE_06_ACCEPTANCE_REF=<ref> \
GREPMIND_PHASE_07_ACCEPTANCE_REF=<ref> \
GREPMIND_PHASE_08_ACCEPTANCE_REF=<ref> \
GREPMIND_CROSS_REPLICA_UI_REF=<ref> \
GREPMIND_CROSS_REPLICA_AGENT_REF=<ref> \
GREPMIND_CANONICAL_POD_DELETE_DRILL_REF=<ref> \
GREPMIND_PRIVATE_SYNC_DISABLED_REF=<ref> \
GREPMIND_ROLLBACK_DRILL_REF=<ref> \
./bin/verify-launch-gate.sh
```

Runbooks live under `runbooks/`.

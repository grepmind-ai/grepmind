# Rollback Runbook

Rollback app and worker image/config together. Do not roll back only one role
when runtime contracts changed.

## Inspect

```sh
kubectl -n <namespace> get deploy,rs,pods -l app.kubernetes.io/name=grepmind -o wide
kubectl -n <namespace> describe deployment/grepmind-app
kubectl -n <namespace> describe deployment/grepmind-worker
kubectl -n <namespace> logs deploy/grepmind-app --tail=200
kubectl -n <namespace> logs deploy/grepmind-worker --tail=200
```

Check `/api/health` for `processRole`, `deploymentContext`,
`realtimeTransport`, `pubsub`, `dbos`, `workers` and `lifecycle`.

## Execute

If ConfigMap or Secret values changed, apply the rollback config first or in the
same operator window. Schema rollback is out of scope for this template.

```sh
kubectl -n <namespace> rollout undo deployment/grepmind-worker
kubectl -n <namespace> rollout undo deployment/grepmind-app
kubectl -n <namespace> rollout status deployment/grepmind-worker --timeout=300s
kubectl -n <namespace> rollout status deployment/grepmind-app --timeout=300s
```

Verify old pods become ready:

```sh
kubectl -n <namespace> get pods -l app.kubernetes.io/name=grepmind -o wide
```

## Stop Criteria

Stop and make a migration-specific decision if the rollback image cannot run
against the current database schema. Do not expose worker publicly as a
rollback workaround.

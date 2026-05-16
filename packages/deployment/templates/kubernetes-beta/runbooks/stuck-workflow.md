# Stuck Workflow Runbook

Use this when canonical indexing or a DBOS-backed branch sync appears stuck.

## Inspect

```sh
kubectl -n <namespace> get pods -l app.kubernetes.io/name=grepmind -o wide
kubectl -n <namespace> logs deploy/grepmind-worker --tail=300
kubectl -n <namespace> describe pod -l app.kubernetes.io/component=worker
```

Check worker `/api/health` fields:

- `dbos.enabled` and `dbos.initialized`;
- `workers.branchSyncDispatcher`;
- `workers.branchSyncRecovery`;
- `workers.revisionMaterializationActiveStateCleanup`;
- `concurrency.queues`;
- `concurrency.providerBackoff`.

## Safe Actions

```sh
kubectl -n <namespace> rollout status deployment/grepmind-worker --timeout=300s
kubectl -n <namespace> logs deploy/grepmind-worker --since=15m
```

If the worker is not ready because dependency initialization is retrying, wait
for readiness after restoring the dependency. If the worker pod is unhealthy at
the process level, allow Kubernetes to replace it through normal liveness.

## Out of Scope

Manual database updates to DBOS or branch sync tables require explicit operator
approval and a recorded recovery decision.

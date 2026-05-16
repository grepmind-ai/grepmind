# Stale Lease Runbook

Use this when branch sync lease takeover or active materialization cleanup is
not progressing after a pod replacement.

## Inspect

```sh
kubectl -n <namespace> get pods -l app.kubernetes.io/name=grepmind -o wide
kubectl -n <namespace> logs deploy/grepmind-worker --since=30m
```

Check worker `/api/health` fields:

- `workerIdentity`;
- `workers.branchSyncDispatcher.staleTakeoverCount`;
- `workers.branchSyncRecovery`;
- `workers.bindingPrivateSync.mode`;
- `revisionMaterializationActiveState`;
- `dbos.initialized`.

## Safe Actions

Wait for the configured stale lease window and verify the replacement worker is
ready:

```sh
kubectl -n <namespace> rollout status deployment/grepmind-worker --timeout=300s
```

If progress does not resume, collect pod logs, Kubernetes events and health
output before any database intervention.

## Out of Scope

Do not manually delete lease rows or active-state rows without an explicit
operator decision. Those changes can hide the actual recovery state.

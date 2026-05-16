# Provider Throttling Runbook

Use this when GitHub, Voyage, S3, Clerk or other provider limits degrade beta
traffic.

## Inspect

```sh
kubectl -n <namespace> logs deploy/grepmind-app --since=30m
kubectl -n <namespace> logs deploy/grepmind-worker --since=30m
```

Check `/api/health` fields:

- `providers`;
- `concurrency.providerBackoff`;
- `concurrency.queues`;
- `concurrency.leases`;
- `workers.branchSyncDispatcher.blockedReason`;
- `workers.repoGcDispatcher.blockedReason`.

## Expected Behavior

Provider throttling should reduce readiness only when the pod cannot safely
serve its role. It must not create unbounded worker concurrency. Liveness should
remain tied to the Node/Fastify process.

## Safe Actions

Lower beta traffic, wait for backoff windows, and verify queue depths stop
growing. Keep HPA disabled until DB/provider budget automation exists.

## Out of Scope

Do not raise provider concurrency limits or DB pool values without recalculating
the DB budget and recording the new cap/headroom.

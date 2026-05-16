# Redis Pub/Sub Outage Runbook

Use this when Upstash Redis-compatible Pub/Sub is disconnected or degraded.

## Inspect

```sh
kubectl -n <namespace> get pods -l app.kubernetes.io/name=grepmind -o wide
kubectl -n <namespace> logs deploy/grepmind-app --since=15m
kubectl -n <namespace> logs deploy/grepmind-worker --since=15m
```

Check `/api/health` fields:

- `realtimeTransport`;
- `pubsub.publisherConnected`;
- `pubsub.subscriberConnected`;
- `pubsub.publishFailureCount`;
- `pubsub.subscribeFailureCount`;
- `pubsub.lastPublishFailureMessage`;
- `pubsub.lastSubscribeFailureMessage`;
- `lifecycle`.

## Expected Behavior

App pods should become unready if publisher or subscriber connectivity is lost.
Worker pods should become unready if publisher connectivity is lost. Worker
subscriber lifecycle is disabled and must not block readiness.

Liveness uses `/api/health` and should not restart pods solely because Redis is
reconnecting.

## Safe Actions

Verify Upstash availability and network egress, then wait for reconnect:

```sh
kubectl -n <namespace> rollout status deployment/grepmind-app --timeout=300s
kubectl -n <namespace> rollout status deployment/grepmind-worker --timeout=300s
```

Escalate to rollback only if the outage is tied to a new image/config rollout
and the previous image/config is known to be compatible with the current schema.

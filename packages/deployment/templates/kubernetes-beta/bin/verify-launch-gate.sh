#!/usr/bin/env sh
set -eu

namespace="${GREPMIND_NAMESPACE:-grepmind-beta}"

require_env() {
  name="$1"
  value="$(eval "printf '%s' \"\${$name:-}\"")"
  if [ -z "$value" ]; then
    echo "missing required evidence env: $name" >&2
    exit 1
  fi
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

assert_equals() {
  actual="$1"
  expected="$2"
  label="$3"
  if [ "$actual" != "$expected" ]; then
    echo "$label: expected $expected, got ${actual:-<empty>}" >&2
    exit 1
  fi
}

require_command kubectl

require_env GREPMIND_PHASE_04_ACCEPTANCE_REF
require_env GREPMIND_PHASE_05_ACCEPTANCE_REF
require_env GREPMIND_PHASE_06_ACCEPTANCE_REF
require_env GREPMIND_PHASE_07_ACCEPTANCE_REF
require_env GREPMIND_PHASE_08_ACCEPTANCE_REF
require_env GREPMIND_IMAGE_TAG
require_env GREPMIND_RUNTIME_REVISION
require_env GREPMIND_CROSS_REPLICA_UI_REF
require_env GREPMIND_CROSS_REPLICA_AGENT_REF
require_env GREPMIND_CANONICAL_POD_DELETE_DRILL_REF
require_env GREPMIND_PRIVATE_SYNC_DISABLED_REF
require_env GREPMIND_ROLLBACK_DRILL_REF

job_complete="$(
  kubectl -n "$namespace" get job grepmind-migrate \
    -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}'
)"
assert_equals "$job_complete" "True" "migration job completion"

migration_logs="$(kubectl -n "$namespace" logs job/grepmind-migrate)"
case "$migration_logs" in
  *ERROR*|*Error*|*error*|*FAILED*|*Failed*|*failed*)
    echo "migration job logs contain an error/failure marker" >&2
    exit 1
    ;;
esac

app_ready="$(
  kubectl -n "$namespace" get deployment grepmind-app \
    -o jsonpath='{.status.readyReplicas}'
)"
assert_equals "${app_ready:-0}" "2" "app ready replicas"

worker_ready="$(
  kubectl -n "$namespace" get deployment grepmind-worker \
    -o jsonpath='{.status.readyReplicas}'
)"
assert_equals "${worker_ready:-0}" "1" "worker ready replicas"

if kubectl -n "$namespace" get service grepmind-worker >/dev/null 2>&1; then
  echo "worker Service must not exist in Kubernetes beta" >&2
  exit 1
fi

ingress_backends="$(
  kubectl -n "$namespace" get ingress \
    -o jsonpath='{range .items[*].spec.rules[*].http.paths[*]}{.backend.service.name}{"\n"}{end}' \
    | sort -u
)"
assert_equals "$ingress_backends" "grepmind-app" "Ingress backend services"

check_endpoint() {
  deployment="$1"
  port="$2"
  path="$3"
  expected_role="$4"
  kubectl -n "$namespace" exec "deployment/$deployment" -- node -e "
    const url = 'http://127.0.0.1:$port$path';
    fetch(url).then(async (response) => {
      const body = await response.json();
      if (!response.ok) {
        throw new Error(url + ' returned HTTP ' + response.status + ': ' + JSON.stringify(body));
      }
      if (body.processRole !== '$expected_role') {
        throw new Error(url + ' processRole is not $expected_role: ' + JSON.stringify(body));
      }
      if ('$path' === '/api/ready' && body.ready !== true) {
        throw new Error(url + ' did not report ready=true: ' + JSON.stringify(body));
      }
      if (body.deploymentContext !== 'beta') {
        throw new Error(url + ' deploymentContext is not beta: ' + JSON.stringify(body));
      }
      if (body.realtimeTransport && body.realtimeTransport !== 'redis-compatible') {
        throw new Error(url + ' realtimeTransport is not redis-compatible: ' + JSON.stringify(body));
      }
    }).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  "
}

check_endpoint grepmind-app 3847 /api/ready app
check_endpoint grepmind-worker 3848 /api/ready worker
check_endpoint grepmind-app 3847 /api/health app

kubectl -n "$namespace" exec deployment/grepmind-worker -- node -e "
  fetch('http://127.0.0.1:3848/api/health').then(async (response) => {
    const body = await response.json();
    if (!response.ok) {
      throw new Error('/api/health returned HTTP ' + response.status + ': ' + JSON.stringify(body));
    }
    if (body.deploymentContext !== 'beta') {
      throw new Error('worker deploymentContext is not beta: ' + JSON.stringify(body));
    }
    if (body.processRole !== 'worker') {
      throw new Error('worker processRole is not worker: ' + JSON.stringify(body));
    }
    if (body.realtimeTransport !== 'redis-compatible') {
      throw new Error('worker realtimeTransport is not redis-compatible: ' + JSON.stringify(body));
    }
    if (body.workers?.bindingPrivateSync?.mode !== 'disabled') {
      throw new Error('binding-private sync is not disabled: ' + JSON.stringify(body.workers?.bindingPrivateSync));
    }
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
"

cat <<EOF
Kubernetes beta launch gate verified for namespace: $namespace
image: $GREPMIND_IMAGE_TAG
runtime revision: $GREPMIND_RUNTIME_REVISION
phase 04: $GREPMIND_PHASE_04_ACCEPTANCE_REF
phase 05: $GREPMIND_PHASE_05_ACCEPTANCE_REF
phase 06: $GREPMIND_PHASE_06_ACCEPTANCE_REF
phase 07: $GREPMIND_PHASE_07_ACCEPTANCE_REF
phase 08: $GREPMIND_PHASE_08_ACCEPTANCE_REF
cross-replica UI: $GREPMIND_CROSS_REPLICA_UI_REF
cross-replica agent: $GREPMIND_CROSS_REPLICA_AGENT_REF
canonical pod deletion drill: $GREPMIND_CANONICAL_POD_DELETE_DRILL_REF
private sync disabled evidence: $GREPMIND_PRIVATE_SYNC_DISABLED_REF
rollback drill: $GREPMIND_ROLLBACK_DRILL_REF
EOF

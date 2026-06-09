# @grepmind/deployment

<!-- release: patch refresh -->

Deployment templates consumed by the `grepmind deploy` CLI.

Templates are shipped as package files:

- `templates/docker` - Docker Compose deployment for a single Linux VM.
- `templates/aws-terraform` - AWS deployment behind ALB, ACM, and Route53.
- `templates/kubernetes-beta` - controlled SaaS beta app/worker split for
  Kubernetes, including `bin/verify-launch-gate.sh` for staging evidence checks.

The Kubernetes beta template is intentionally narrower than the Docker and AWS
templates: it expects a phase 09-compatible image/template pair, Redis-compatible
Pub/Sub, two app replicas, one worker replica, app-only ingress, disabled
binding-private sync, and explicit launch-gate evidence before approval.

Use the public CLI instead of importing template paths directly:

```sh
npx grepmind deploy list
npx grepmind deploy init
npx grepmind deploy init docker
npx grepmind deploy init aws-terraform
npx grepmind deploy init kubernetes-beta
```

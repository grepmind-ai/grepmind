# @grepmind/deployment

Deployment templates consumed by the `grepmind deploy` CLI.

Templates are shipped as package files:

- `templates/docker` - Docker Compose deployment for a single Linux VM.
- `templates/aws-terraform` - AWS deployment behind ALB, ACM, and Route53.

Use the public CLI instead of importing template paths directly:

```sh
npx grepmind deploy list
npx grepmind deploy init
npx grepmind deploy init docker
npx grepmind deploy init aws-terraform
```

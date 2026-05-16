# Grepmind

Public npm workspace for the Grepmind local agent packages.

Grepmind connects a local Git workspace to a Grepmind backend, keeps branch-aware local runtime state, and exposes that state through a CLI, a typed local RPC client, and an MCP server.

## Packages

| Package                                       | Description                                             |
| --------------------------------------------- | ------------------------------------------------------- |
| [`grepmind`](packages/grepmind)               | Public, human-facing CLI entrypoint.                    |
| [`@grepmind/agent`](packages/agent)           | Local branch-aware agent runtime and lower-level CLI.   |
| [`@grepmind/agent-rpc`](packages/agent-rpc)   | Typed client for the local agent runtime socket.        |
| [`@grepmind/mcp`](packages/mcp)               | MCP server exposing Grepmind-backed local search tools. |
| [`@grepmind/deployment`](packages/deployment) | Deployment templates consumed by `grepmind deploy`.     |

## Requirements

- Node.js 18 or newer.
- npm with workspace support.
- A Git workspace with an `origin` remote when registering projects.
- A compatible Grepmind backend with Grepmind CLI OAuth enabled.

## Install From npm

Install the public CLI:

```sh
npm install -g grepmind
```

Install lower-level packages directly when you need their specific API or binary:

```sh
npm install -g @grepmind/agent
npm install @grepmind/agent-rpc
npm install -g @grepmind/mcp
```

## Quick Start

```sh
grepmind auth login \
  --hostname your-grepmind-server.example \
  --name "$(hostname)"

grepmind agent run -d
grepmind agent register --workspace ~/work/your-repo
grepmind agent projects
```

Agent authentication is browser-based OAuth Authorization Code + PKCE. The previous manual token/API key agent configuration flow has been removed.

## Development

Install dependencies from the repository root:

```sh
npm install
```

Build all packages:

```sh
npm run build
```

Build individual packages:

```sh
npm run build:agent-rpc
npm run build:agent
npm run build:mcp
npm run build:deployment
npm run build:grepmind
```

Run the public CLI from source:

```sh
npm run grepmind -- agent help
npm run grepmind -- deploy list
```

Run the lower-level agent CLI from the built package:

```sh
npm run agent -- help
```

Run the lower-level agent CLI from source:

```sh
npm run agent:dev -- help
```

## Repository Layout

```text
packages/
  agent/      Local runtime and lower-level CLI
  agent-rpc/  Runtime socket client and protocol types
  deployment/ Docker Compose, AWS Terraform and Kubernetes beta deployment templates
  grepmind/   Public CLI wrapper
  mcp/        MCP stdio server
tools/        Shared build and release scripts
```

The workspace is ESM-first and publishes built files from `dist`.

## Release

Releases are automated with GitHub Actions and Changesets.

Package source changes must include a Changeset:

```sh
npm run changeset
```

The `Changeset Required` workflow enforces this for pull requests that touch
package source files under `packages/**/src`, package scripts/migrations, or
deployment templates under `packages/**/templates`. Documentation-only changes
do not trigger a new version.

Stable releases use the `main` branch:

1. Merge a source change and its `.changeset/*.md` file into `main`.
2. The `Release` workflow opens a `chore: version packages` pull request.
3. Review and merge that version pull request.
4. The same workflow publishes changed packages to npm with the `latest` tag.

Beta prereleases use the `beta` branch:

1. Create or update the `beta` branch from `main`.
2. Merge beta-bound source changes and their Changesets into `beta`.
3. The `Release` workflow opens a `chore: version packages (beta)` pull request.
4. Review and merge that version pull request.
5. The same workflow publishes changed packages to npm with the `beta` tag.

The beta workflow enters Changesets prerelease mode on the `beta` branch. Keep
`.changeset/pre.json` out of `main`.

Manual local checks for release packaging:

```sh
npm run build
npm run pack:dry-run
```

npm publishing is designed for Trusted Publishing/OIDC. Configure each public
npm package to trust this repository and the `.github/workflows/release.yml`
workflow, then restrict token-based publishing after the first successful run.

## Support

Report bugs and request features through [GitHub Issues](https://github.com/zaytra-labs/grepmind/issues).

## License

Apache-2.0

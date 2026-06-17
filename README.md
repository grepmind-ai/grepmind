# Grepmind

[Grepmind](https://grepmind.ai) is a context layer for coding agents. It gives
agents searchable, branch-aware codebase knowledge over MCP so they can find the
right files, snippets, and line references before planning or editing.

Grepmind is built for agentic development workflows where Codex, Claude Code,
Cursor, and other MCP-compatible agents need current repository context without
loading an entire codebase into a prompt.

- **Website:** [grepmind.ai](https://grepmind.ai)
- **Docs:** [grepmind.ai/en/docs](https://grepmind.ai/en/docs/introduction/)
- **Quickstart:** [grepmind.ai/en/docs/quickstart](https://grepmind.ai/en/docs/quickstart/)
- **Cloud app:** [app.grepmind.ai](https://app.grepmind.ai)

## What Grepmind Does

Grepmind indexes repositories, documentation, and branches, then exposes that
context to coding agents through a project-local MCP server. Agents can ask
Grepmind for relevant implementation paths, similar code, documentation, or
reviewable snippets while they work in a local Git workspace.

Grepmind helps agents:

- search code by meaning instead of only exact keywords;
- stay aligned with the current repository and branch context;
- return verifiable results with files, line ranges, snippets, branch context,
  and source metadata;
- avoid bloated prompts full of pasted file paths and background notes;
- reuse the same repository context across multiple agents and team members.

## Product Highlights

- **Semantic code search:** find relevant code and docs from natural-language
  queries.
- **Continuous codebase sync:** keep local search context aligned with fresh
  commits and active branches.
- **Project-local MCP:** bind each agent session to the Git workspace it starts
  from, reducing wrong-repository searches.
- **Agent integrations:** connect Codex, Claude Code, Cursor, and custom stdio
  MCP clients.
- **Usage visibility:** review repository activity, indexing, and agent search
  usage in the product.
- **Cloud or self-hosted:** use Grepmind Cloud or deploy Grepmind in your own
  infrastructure with the published CLI templates.

## How It Works

```text
Coding agent -> Grepmind MCP -> Grepmind Agent -> Semantic search -> Relevant code results
```

The local MCP server starts inside a specific Git workspace. The local Grepmind
agent connects that workspace to the Grepmind Platform, tracks the current HEAD,
and returns focused retrieval results to the coding agent.

Grepmind Platform manages the web app, projects, permissions, repository
mapping, integrations, indexes, embeddings, and search artifacts. The platform
does not become the source of truth for source code; your Git host and local
working copy remain the source of truth.

## Quick Start

Start from a local Git workspace that has an `origin` remote and a Grepmind Cloud
or self-hosted account.

```sh
npx grepmind init
```

Or configure a specific MCP client:

```sh
npx grepmind init --codex
npx grepmind init --claude --yes
npx grepmind init --cursor --dry-run
```

`grepmind init` writes commit-safe project configuration, updates the selected
project-local MCP client config, starts or reuses the local agent runtime, and
registers or reuses the current Git workspace binding.

Generated project-local files can include:

- `.grepmind.json`
- `.codex/config.toml` for Codex
- `.mcp.json` for Claude Code
- `.cursor/mcp.json` for Cursor

OAuth tokens, refresh tokens, account session tokens, binding ids, secure-storage
keys, and absolute workspace paths are not written to project files by default.

After setup, ask your coding agent to use Grepmind explicitly:

```text
Use Grepmind code_search to find where user input is validated before saving
settings. Return the files and line ranges before proposing a code change.
```

When you know a concrete identifier or string, ask the agent to include it as
`exact.pattern` so Grepmind can combine semantic search with local `rg` matches.

## Install

Use the public CLI directly with `npx`:

```sh
npx grepmind init
```

Or install it globally:

```sh
npm install -g grepmind
```

Install lower-level packages directly only when you need their specific API or
binary:

```sh
npm install -g @grepmind/agent
npm install @grepmind/agent-rpc
npm install -g @grepmind/mcp
```

## Self-Hosting

Grepmind can be deployed in your own infrastructure. The deployment wizard ships
with the public CLI:

```sh
npx grepmind deploy init
```

Available template paths:

```sh
npx grepmind deploy init docker --dir grepmind-deployment
npx grepmind deploy init aws-terraform --dir grepmind-aws-terraform
npx grepmind deploy init kubernetes-beta --dir grepmind-kubernetes-beta
```

Self-hosting templates cover Docker Compose for a single Linux VM, AWS Terraform,
and a controlled Kubernetes beta path. See the
[deployment docs](https://grepmind.ai/en/docs/deployment/overview/) for
requirements and operating guidance.

## Repository Packages

This repository is the public npm workspace for the Grepmind local agent,
MCP, CLI, and deployment packages.

| Package                                       | Description                                             |
| --------------------------------------------- | ------------------------------------------------------- |
| [`grepmind`](packages/grepmind)               | Public CLI for init, local agent commands, and deploy.  |
| [`@grepmind/agent`](packages/agent)           | Local branch-aware agent runtime and lower-level CLI.   |
| [`@grepmind/agent-rpc`](packages/agent-rpc)   | Typed client for the local agent runtime socket.        |
| [`@grepmind/mcp`](packages/mcp)               | MCP server exposing Grepmind-backed local search tools. |
| [`@grepmind/deployment`](packages/deployment) | Deployment templates consumed by `grepmind deploy`.     |

## Requirements

- Node.js 18 or newer.
- npm with workspace support.
- A Git workspace with an `origin` remote when registering projects.
- A Grepmind Cloud account or compatible self-hosted Grepmind backend with CLI
  OAuth enabled.

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
  deployment/ Docker Compose, AWS Terraform, and Kubernetes beta templates
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
package source files under `packages/**/src`, package scripts or migrations, or
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

npm publishing is designed for Trusted Publishing/OIDC. Configure each public npm
package to trust this repository and the `.github/workflows/release.yml`
workflow, then restrict token-based publishing after the first successful run.

## Support

- Product docs: [grepmind.ai/en/docs](https://grepmind.ai/en/docs/introduction/)
- Issues and feature requests:
  [GitHub Issues](https://github.com/grepmind-ai/grepmind/issues)

## License

Apache-2.0

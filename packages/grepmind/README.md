# grepmind

<!-- release: patch refresh -->

[Website](https://grepmind.ai)

Public command-line utility for running a local Grepmind agent, initializing
project-local MCP client config, and initializing Grepmind deployment templates.

`grepmind` is the operator-friendly entrypoint into the Grepmind workflow. It
wraps `@grepmind/agent` for local agent commands, configures project-local MCP
clients, and consumes `@grepmind/deployment` for Docker Compose, AWS Terraform
and Kubernetes beta deployment templates.

## Requirements

- Node.js 18 or newer.
- A compatible Grepmind backend with Grepmind CLI OAuth enabled.
- A local Git workspace with an `origin` remote for `register`.

## Install

```sh
npm install -g grepmind
```

## Quick Start

Use `init` from inside a Git workspace to configure local MCP search:

```sh
grepmind init --codex
grepmind init --cursor --yes
grepmind init --all-detected
grepmind init --codex --dry-run
```

`grepmind init` uses browser-based OAuth when login is required, starts or reuses
the local agent runtime, registers or reuses the current Git workspace binding,
writes `.grepmind.json`, and updates selected project-local MCP client config.

`register`, `projects`, and `clean` talk to the local runtime. Start the runtime before using them.

```sh
grepmind auth login \
  --hostname your-grepmind-server.example \
  --name "$(hostname)"

grepmind agent run -d
grepmind agent register --workspace ~/work/your-repo
grepmind agent projects
```

Agent authentication is browser-based OAuth Authorization Code + PKCE. The previous manual token/API key agent configuration flow has been removed.

## Project MCP Setup

```sh
grepmind init [--codex|--claude|--cursor] [--yes]
```

Generated files are project-local:

- `.grepmind.json`
- `.codex/config.toml` for Codex
- `.mcp.json` for Claude Code
- `.cursor/mcp.json` for Cursor

`.grepmind.json` is commit-safe. It stores the backend hostname and optional
code/docs indexing rules. Generated files omit `code` and `docs` until you add
custom rules. MCP package, startup timeout, command, args, env, and
client-specific fields live in MCP client config, not `.grepmind.json`. OAuth
tokens, refresh tokens, account session tokens, binding ids, secure-storage
keys, and absolute workspace paths are not written to `.grepmind.json`.
`GREPMIND_AGENT_DATA_DIR` is written to MCP client config only when `--data-dir`
is explicitly passed.

`--yes` skips terminal prompts but still allows the OAuth browser flow. Fully
non-interactive mode is `--yes --no-open`; if auth or account selection is
missing, it fails with a command to run first.

Supported initial clients are Codex, Claude Code, and Cursor. OpenCode and
Gemini CLI are detected only as unsupported phase 2 clients.

Client notes:

- Codex reads project MCP config only for trusted projects.
- Claude Code may ask to approve the project-scoped `.mcp.json` server before first use.
- Cursor may need the workspace reloaded after MCP config changes.

The default MCP command is `npx -y @grepmind/mcp@0.1.1`. To update the package
used by MCP client config, rerun:

```sh
grepmind init --codex --force --mcp-package @grepmind/mcp@latest
```

## Deployment Setup

Use the deployment wizard for guided setup:

```sh
npx grepmind deploy init
```

Copy a Docker Compose deployment template without prompting:

```sh
npx grepmind deploy init docker --dir grepmind-deployment
```

Copy an AWS Terraform deployment template without prompting:

```sh
npx grepmind deploy init aws-terraform --dir grepmind-aws-terraform
```

Copy the controlled Kubernetes beta template without prompting:

```sh
npx grepmind deploy init kubernetes-beta --dir grepmind-kubernetes-beta
```

List shipped deployment targets:

```sh
grepmind deploy list
```

## Commands

```text
grepmind

Commands:
  grepmind auth login --hostname <host>
  grepmind auth status
  grepmind auth logout
  grepmind agent auth login --hostname <host>
  grepmind agent register --workspace <path>
  grepmind agent run
  grepmind agent projects
  grepmind agent clean --workspace <path>
  grepmind agent clean --all
  grepmind init [--codex|--claude|--cursor] [--yes]
  grepmind deploy init
  grepmind deploy init docker
  grepmind deploy init aws-terraform
  grepmind deploy init kubernetes-beta
  grepmind deploy list
```

### `grepmind auth login`

```sh
grepmind auth login --hostname <host> [options]
grepmind agent auth login --hostname <host> [options]
```

Common options:

- `--name <agent-name>`
- `--data-dir <dir>`
- `--scopes <scope,...>`
- `--no-open`
- `--callback-port <port>`
- `--poll-interval-ms <ms>`
- `--head-poll-interval-ms <ms>`

Login opens the browser for Clerk OAuth Authorization Code + PKCE, stores OAuth secrets in OS secure storage, and writes only non-secret metadata to local config.

### `grepmind agent run`

Starts the long-running local runtime.

```sh
grepmind agent run [options]
```

Common options:

- `-d`, `--detach` starts in the background.
- `--trace` enables verbose runtime logs.
- `--data-dir <dir>` selects a non-default runtime data directory.

### `grepmind agent register`

Registers a local Git workspace with the running runtime.

```sh
grepmind agent register --workspace <path> [options]
```

Common options:

- `--display-name <name>`
- `--branch <branch>`
- `--data-dir <dir>`

The workspace must exist and have an `origin` remote configured.

### `grepmind agent projects`

Lists registered local workspaces.

```sh
grepmind agent projects
grepmind agent list
```

`list` is an alias for `projects`.

### `grepmind agent clean`

Deletes local Grepmind data for a registered workspace.

```sh
grepmind agent clean --workspace <path> [--data-dir <dir>]
grepmind agent clean --all|-a [--data-dir <dir>]
```

This command asks for `y/n` confirmation before deleting local runtime data. It does not remove server-side bindings or agent configuration.

## Environment Variables

Most configuration can be supplied through environment variables:

| Variable                               | Description                           |
| -------------------------------------- | ------------------------------------- |
| `GREPMIND_AGENT_NAME`                  | Local agent display name.             |
| `GREPMIND_AGENT_DATA_DIR`              | Local runtime data directory.         |
| `GREPMIND_AGENT_POLL_INTERVAL_MS`      | Project sync poll interval.           |
| `GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS` | Local branch HEAD poll interval.      |
| `GREPMIND_AGENT_TRACE=1`               | Enable detailed runtime trace output. |
| `GREPMIND_AGENT_TRACE_HTTP=1`          | Include HTTP trace output.            |

By default, local state is stored in `~/.grepmind-agent`.

## Technical Notes

- Package type: ESM.
- Binary: `grepmind`.
- Public npm package: `grepmind`.
- Runtime implementation: delegated to `@grepmind/agent`.
- Deployment templates: delegated to `@grepmind/deployment`.
- Supported public command namespace: `grepmind auth`, `grepmind agent auth`, `grepmind agent run`, `stop`, `register`, `projects`, `list`, `clean`, `init`, and `deploy`.

Use `grepmind` for the stable public CLI. Use `@grepmind/agent` directly when you need lower-level runtime commands such as `sync`, `status`, `search-head`, `remove`, `reset`, or `bootstrap`.

## Development

From the repository root:

```sh
npm run build:grepmind
npm run grepmind -- agent help
npm run grepmind -- init --codex --dry-run
npm run grepmind -- deploy list
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/grepmind-ai/grepmind/issues).

## License

Apache-2.0

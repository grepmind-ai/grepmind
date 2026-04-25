# Grepmind

Public npm workspace for the Grepmind local agent packages.

Grepmind connects a local Git workspace to a Grepmind backend, keeps branch-aware local runtime state, and exposes that state through a CLI, a typed local RPC client, and an MCP server.

## Packages

| Package                                     | Description                                             |
| ------------------------------------------- | ------------------------------------------------------- |
| [`grepmind`](packages/grepmind)             | Public, human-facing CLI entrypoint.                    |
| [`@grepmind/agent`](packages/agent)         | Local branch-aware agent runtime and lower-level CLI.   |
| [`@grepmind/agent-rpc`](packages/agent-rpc) | Typed client for the local agent runtime socket.        |
| [`@grepmind/mcp`](packages/mcp)             | MCP server exposing Grepmind-backed local search tools. |

## Requirements

- Node.js 18 or newer.
- npm with workspace support.
- A Git workspace with an `origin` remote when registering projects.
- A compatible Grepmind backend for agent configuration and sync.

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
grepmind agent configure \
  --url https://your-grepmind-server.example \
  --name "$(hostname)"

grepmind agent run -d
grepmind agent register --workspace ~/work/your-repo
grepmind agent projects
```

Use `--token` or `--api-key` with `configure` when your backend requires credentials.

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
npm run build:grepmind
```

Run the public CLI from source:

```sh
npm run grepmind -- agent help
```

Run the lower-level agent CLI from source:

```sh
npm run agent -- help
```

## Repository Layout

```text
packages/
  agent/      Local runtime and lower-level CLI
  agent-rpc/  Runtime socket client and protocol types
  grepmind/   Public CLI wrapper
  mcp/        MCP stdio server
tools/        Shared build and release scripts
```

The workspace is ESM-first and publishes built files from `dist`.

## Release

Each public package has a workspace release script:

```sh
npm run release:grepmind -- <version>
npm run release:agent -- <version>
npm run release:agent-rpc -- <version>
npm run release:mcp -- <version>
```

Dry-run variants are also available:

```sh
npm run release:grepmind:dry-run
npm run release:agent:dry-run
npm run release:agent-rpc:dry-run
npm run release:mcp:dry-run
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/zaytra-labs/grepmind/issues).

## License

Apache-2.0

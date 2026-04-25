# @grepmind/agent

Local branch-aware Grepmind agent runtime backed by PGlite.

`@grepmind/agent` contains the lower-level runtime and CLI used by the public `grepmind` package. It is responsible for storing local state, registering workspaces, syncing project data from the Grepmind backend, tracking local Git HEAD changes, and serving runtime operations over a local socket.

## Requirements

- Node.js 18 or newer.
- A compatible Grepmind backend.
- A local Git workspace with an `origin` remote for project registration.

## Install

```sh
npm install -g @grepmind/agent
```

## Public API

The supported package surface is intentionally small:

- `grepmind-agent`, the executable CLI binary.
- `runAgentCli(argv: string[]): Promise<void>` from `@grepmind/agent`.

```js
import { runAgentCli } from '@grepmind/agent';

await runAgentCli(['run']);
```

Runtime classes, repositories, database schema, migrations, backend clients, realtime transports, and service internals are implementation details and are not supported package APIs.

## Quick Start

```sh
grepmind-agent configure \
  --url https://your-grepmind-server.example \
  --name "$(hostname)"

grepmind-agent run -d
grepmind-agent register --workspace ~/work/your-repo
grepmind-agent projects
```

## Commands

```text
grepmind-agent

Commands:
  configure --url <backend> [--token <token>] [--name <agent>] [--data-dir <dir>] [--poll-interval-ms <ms>] [--head-poll-interval-ms <ms>]
  run [--data-dir <dir>] [-d|--detach] [--trace]
  stop [--data-dir <dir>]
  register --workspace <path> [--display-name <name>] [--branch <branch>] [--data-dir <dir>]
  projects [--data-dir <dir>]
  sync [--binding-id <id>] [--data-dir <dir>]
  status|state [--binding-id <id>] [--branch <branch>] [--commit-sha <sha>] [--limit <n>] [--data-dir <dir>]
  search-head --query <text> [--binding-id <id>] [--workspace <path>] [--target code|docs] [--limit <n>] [--threshold <0-1>] [--no-rerank] [--json] [--data-dir <dir>]
  unbind|remove --binding-id <id> [--data-dir <dir>]
  clean --workspace <path> [--data-dir <dir>]
  bootstrap [--data-dir <dir>]
  reset [--data-dir <dir>]
```

### Runtime Commands

- `configure` writes local config and checks backend bootstrap.
- `run` starts the long-running runtime; use `-d` or `--detach` for background mode.
- `stop` requests graceful shutdown for the runtime using the same data directory.
- `bootstrap` checks backend compatibility and prints server/runtime defaults.
- `reset` removes local agent configuration.

### Project Commands

- `register` attaches a Git workspace to the running runtime.
- `projects` lists registered local workspaces.
- `sync` requests project sync for one binding or all registered bindings.
- `unbind` / `remove` removes a local binding.
- `clean` deletes local runtime data for a workspace after interactive confirmation.

### Inspection Commands

- `status` / `state` prints local attachment, payload, and materialization state.
- `search-head` searches the current local HEAD for a registered workspace.

## Environment Variables

| Variable                               | Description                           |
| -------------------------------------- | ------------------------------------- |
| `GREPMIND_AGENT_URL`                   | Backend URL.                          |
| `GREPMIND_AGENT_TOKEN`                 | Access token.                         |
| `GREPMIND_AGENT_API_KEY`               | API key.                              |
| `GREPMIND_AGENT_NAME`                  | Local agent display name.             |
| `GREPMIND_AGENT_DEVICE_ID`             | Stable device id override.            |
| `GREPMIND_AGENT_DATA_DIR`              | Local runtime data directory.         |
| `GREPMIND_AGENT_POLL_INTERVAL_MS`      | Project sync poll interval.           |
| `GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS` | Local branch HEAD poll interval.      |
| `GREPMIND_AGENT_TRACE=1`               | Enable detailed runtime trace output. |
| `GREPMIND_AGENT_TRACE_HTTP=1`          | Include HTTP trace output.            |

Defaults: data dir `~/.grepmind-agent`, poll interval `60000ms`, HEAD poll interval `1500ms`.

## Technical Notes

- Package type: ESM.
- Binary: `grepmind-agent`.
- Storage: local PGlite database in the agent data directory.
- Runtime RPC: local socket with protocol types exposed by `@grepmind/agent-rpc`.
- Search targets: `code` and `docs`.
- Local operations requiring runtime state expect a running runtime for the same `--data-dir`.

## Development

From the repository root:

```sh
npm run build:agent
npm run agent -- help
```

Build embedded migrations after migration changes:

```sh
npm -w @grepmind/agent run build:migrations
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/zaytra-labs/grepmind/issues).

## License

Apache-2.0

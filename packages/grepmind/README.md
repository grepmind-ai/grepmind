# grepmind

Public command-line utility for running a local Grepmind agent.

`grepmind` is the operator-friendly entrypoint into the Grepmind workflow. It wraps `@grepmind/agent` and exposes a deliberately small command surface for configuring a machine, starting the local runtime, registering Git workspaces, and listing or cleaning local projects.

## Requirements

- Node.js 18 or newer.
- A compatible Grepmind backend.
- A local Git workspace with an `origin` remote for `register`.

## Install

```sh
npm install -g grepmind
```

## Quick Start

`register`, `projects`, and `clean` talk to the local runtime. Start the runtime before using them.

```sh
grepmind agent configure \
  --url https://your-grepmind-server.example \
  --name "$(hostname)"

grepmind agent run -d
grepmind agent register --workspace ~/work/your-repo
grepmind agent projects
```

If your backend requires credentials:

```sh
grepmind agent configure \
  --url https://your-grepmind-server.example \
  --token <access-token> \
  --api-key <api-key>
```

## Commands

```text
grepmind

Commands:
  grepmind agent configure --url <backend> [--token <token>]
  grepmind agent register --workspace <path>
  grepmind agent run
  grepmind agent projects
  grepmind agent clean --workspace <path>
```

### `grepmind agent configure`

Writes local agent configuration and validates the backend connection.

```sh
grepmind agent configure --url <backend> [options]
```

Common options:

- `--token <token>`
- `--api-key <api-key>`
- `--name <agent-name>`
- `--data-dir <dir>`
- `--poll-interval-ms <ms>`
- `--head-poll-interval-ms <ms>`

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
```

This command asks for `y/n` confirmation before deleting local runtime data. It does not remove server-side bindings or agent configuration.

## Environment Variables

Most configuration can be supplied through environment variables:

| Variable | Description |
| --- | --- |
| `GREPMIND_AGENT_URL` | Backend URL. |
| `GREPMIND_AGENT_TOKEN` | Access token. |
| `GREPMIND_AGENT_API_KEY` | API key. |
| `GREPMIND_AGENT_NAME` | Local agent display name. |
| `GREPMIND_AGENT_DATA_DIR` | Local runtime data directory. |
| `GREPMIND_AGENT_POLL_INTERVAL_MS` | Project sync poll interval. |
| `GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS` | Local branch HEAD poll interval. |
| `GREPMIND_AGENT_TRACE=1` | Enable detailed runtime trace output. |
| `GREPMIND_AGENT_TRACE_HTTP=1` | Include HTTP trace output. |

By default, local state is stored in `~/.grepmind-agent`.

## Technical Notes

- Package type: ESM.
- Binary: `grepmind`.
- Public npm package: `grepmind`.
- Runtime implementation: delegated to `@grepmind/agent`.
- Supported public command namespace: `grepmind agent configure`, `run`, `register`, `projects`, `list`, and `clean`.

Use `grepmind` for the stable public CLI. Use `@grepmind/agent` directly when you need lower-level runtime commands such as `stop`, `sync`, `status`, `search-head`, `remove`, `reset`, or `bootstrap`.

## Development

From the repository root:

```sh
npm run build:grepmind
npm run grepmind -- agent help
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/zaytra-labs/grepmind/issues).

## License

Apache-2.0

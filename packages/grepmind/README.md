# grepmind

> The public CLI for running a local Grepmind agent.

`grepmind` is the operator-friendly entrypoint into the Grepmind agent workflow. It gives you a small, stable command surface for connecting a machine to a Grepmind backend, registering local Git workspaces, and keeping the local runtime online.

If you want the package you install globally and hand to humans, this is it.

## Why this package exists

`grepmind` is a thin wrapper around `@grepmind/agent`, but that thin layer is intentional:

- one global binary: `grepmind`
- one namespace for agent operations: `grepmind agent ...`
- a curated public command set instead of the full low-level runtime surface

That keeps the default UX simple while the underlying agent runtime stays free to expose more advanced internal commands separately.

## Install

```bash
npm install -g grepmind
```

Requires Node.js 18 or newer.

## Quick start

Important: `register`, `projects`, and `clean` talk to the local runtime. Start the runtime first.

```bash
# 1. Save backend configuration
grepmind agent configure \
  --url https://your-grepmind-server.example \
  --name "$(hostname)"

# 2. Start the local runtime in background
grepmind agent run -d

# 3. Register a Git workspace
grepmind agent register --workspace ~/work/your-repo

# 4. Check what is attached
grepmind agent projects
```

If your backend requires credentials, provide them during configuration:

```bash
grepmind agent configure \
  --url https://your-grepmind-server.example \
  --token <access-token> \
  --api-key <api-key>
```

## Mental model

```text
grepmind agent configure   -> writes local agent config
grepmind agent run         -> starts the long-running runtime
grepmind agent register    -> attaches a local Git workspace
grepmind agent projects    -> lists registered workspaces
grepmind agent clean       -> removes local data for a workspace
```

The runtime is branch-aware and long-lived. Run it in the foreground when you want logs in the current terminal, or use `-d` to detach it and continue working.

## Commands

### `grepmind agent configure`

Configures the local machine to talk to a Grepmind backend and persists the config in the local agent data directory.

```bash
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

Starts the long-running local agent runtime.

```bash
grepmind agent run [options]
```

Common options:

- `-d`, `--detach` to start in background
- `--trace` to enable verbose runtime logs
- `--data-dir <dir>`

Foreground mode is useful during setup and debugging. Detached mode is the normal day-to-day workflow.

### `grepmind agent register`

Registers a local Git workspace with the running runtime.

```bash
grepmind agent register --workspace <path> [options]
```

Common options:

- `--display-name <name>`
- `--branch <branch>`
- `--data-dir <dir>`

The workspace must exist locally and have an `origin` remote configured.

### `grepmind agent projects`

Lists registered local workspaces.

```bash
grepmind agent projects
grepmind agent list
```

`list` is an alias for `projects`.

### `grepmind agent clean`

Deletes local Grepmind data for a registered workspace.

```bash
grepmind agent clean --workspace <path> [--data-dir <dir>]
```

This command is interactive and asks for `y/n` confirmation before deleting local runtime data for the workspace. It does not remove server-side bindings or agent configuration.

### `grepmind help`

Prints the top-level CLI help.

## Environment variables

You can provide most configuration through environment variables instead of flags:

- `GREPMIND_AGENT_URL`
- `GREPMIND_AGENT_TOKEN`
- `GREPMIND_AGENT_API_KEY`
- `GREPMIND_AGENT_NAME`
- `GREPMIND_AGENT_DATA_DIR`
- `GREPMIND_AGENT_POLL_INTERVAL_MS`
- `GREPMIND_AGENT_HEAD_POLL_INTERVAL_MS`
- `GREPMIND_AGENT_TRACE=1`
- `GREPMIND_AGENT_TRACE_HTTP=1`

By default, the agent stores its local state in `~/.grepmind-agent`.

## Package boundary

`grepmind` intentionally exposes a smaller surface than `@grepmind/agent`.

Use `grepmind` when you want the public, top-level CLI.

Use `@grepmind/agent` directly when you need lower-level commands such as runtime shutdown, manual sync, detailed status inspection, unbinding, reset, or bootstrap-style diagnostics.

## Links

- Repository: [zaytra-labs/grepmind](https://github.com/zaytra-labs/grepmind)
- Package source: [packages/grepmind](https://github.com/zaytra-labs/grepmind/tree/main/packages/grepmind)
- Issues: [github.com/zaytra-labs/grepmind/issues](https://github.com/zaytra-labs/grepmind/issues)

## License

Apache-2.0

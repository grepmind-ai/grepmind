# @grepmind/agent

CLI-oriented local Grepmind agent package backed by PGlite.

The supported package surface is intentionally small:

- `grepmind-agent`, the executable CLI binary.
- `runAgentCli(argv: string[]): Promise<void>` from root `@grepmind/agent`, for programmatic CLI delegation.

Runtime classes, repositories, database schema, migrations, backend clients, realtime transports, and service internals are implementation details and are not supported package APIs.

## Install

```bash
npm install -g @grepmind/agent
```

## Usage

```bash
grepmind-agent --help
grepmind-agent configure --url https://your-grepmind-server.example
grepmind-agent register --workspace /path/to/workspace
grepmind-agent run
grepmind-agent run --trace
```

Programmatic delegation:

```js
import { runAgentCli } from '@grepmind/agent';

await runAgentCli(['run']);
```

`@grepmind/agent` is the canonical import path. This package does not publish an `@grepmind/agent/cli` runtime entrypoint.

## Commands

- `grepmind-agent configure --url <backend> [--token <token>]`
- `grepmind-agent run [--detach] [--trace]`
- `grepmind-agent stop`
- `grepmind-agent sync [--binding-id <id>]`
- `grepmind-agent state [--binding-id <id>] [--branch <branch>] [--commit-sha <sha>] [--limit <n>]`
- `grepmind-agent register --workspace <path>`
- `grepmind-agent projects`
- `grepmind-agent remove --binding-id <id>`
- `grepmind-agent clean --workspace <path>`
  Prompts for `y/n` confirmation before deleting local agent data for the workspace.
- `grepmind-agent reset`
- `grepmind-agent bootstrap`

## Logging

- `grepmind-agent run` now uses a formatted console with startup splash and structured runtime logs.
- `--trace` or `GREPMIND_AGENT_TRACE=1` enables detailed internal trace output.
- `GREPMIND_AGENT_TRACE_HTTP=1` adds HTTP trace events in the same console style.

## License

Apache-2.0

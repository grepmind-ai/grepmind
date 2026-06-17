# @grepmind/agent-rpc

<!-- release: patch refresh -->

[Website](https://grepmind.ai)

Typed client and local control helpers for the Grepmind agent runtime.

`@grepmind/agent-rpc` lets tools talk to a running `@grepmind/agent` runtime without importing the full runtime implementation. It exposes a small socket client, protocol constants, protocol types, runtime-unavailable error helpers, and bootstrap helpers for tools that need to make sure the local agent is authenticated and running.

## Requirements

- Node.js 18 or newer.
- A running Grepmind agent runtime for direct socket calls.
- The `grepmind-agent` binary, or another configured agent command, for bootstrap helpers that need to run `auth login` or start the runtime.

## Install

```sh
npm install @grepmind/agent-rpc
```

## Usage

```js
import {
  AgentRuntimeClient,
  isRuntimeUnavailableError,
} from '@grepmind/agent-rpc';

const client = new AgentRuntimeClient(`${process.env.HOME}/.grepmind-agent`);

try {
  const ping = await client.ping();
  const projects = await client.listProjects();

  console.log(ping.protocolVersion);
  console.log(projects.items);
} catch (error) {
  if (isRuntimeUnavailableError(error)) {
    console.error('Start the local runtime first.');
  } else {
    throw error;
  }
}
```

Start the runtime with the public CLI:

```sh
grepmind agent run -d
```

Or with the lower-level agent CLI:

```sh
grepmind-agent run -d
```

## Bootstrap helpers

Tools that run over stdio, such as MCP servers, can use `ensureAgentReady()` before accepting requests:

```js
import { ensureAgentReady } from '@grepmind/agent-rpc';

await ensureAgentReady({
  hostname: process.env.GREPMIND_AGENT_HOSTNAME,
});
```

`ensureAgentReady()`:

- resolves the agent data directory from `GREPMIND_AGENT_DATA_DIR` or `~/.grepmind-agent`;
- checks the local agent config and secure credential storage;
- runs `grepmind-agent auth login --hostname <host> --data-dir <dir>` when credentials are missing and a hostname is provided;
- starts a shared detached runtime with `grepmind-agent run --detach --data-dir <dir>` when no runtime is available;
- waits for `ping()` before returning.

By default the helpers use `grepmind-agent`. To use the public CLI namespace instead:

```js
await ensureAgentReady({
  hostname: 'app.grepmind.example',
  command: {
    command: 'grepmind',
    baseArgs: ['agent'],
  },
});
```

Available helpers:

| Helper                         | Description                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `resolveAgentDataDir(input?)`  | Resolves an explicit, env, or default agent data directory.                    |
| `readAgentCliConfig(dataDir?)` | Reads the non-secret local agent config.                                       |
| `getAgentAuthStatus(dataDir?)` | Checks auth config and secure credential availability without exposing tokens. |
| `loginAgent(options)`          | Runs agent OAuth login through the configured CLI command.                     |
| `ensureAgentAuth(options?)`    | Ensures credentials are available, optionally running login.                   |
| `startAgentRuntime(options?)`  | Starts the shared detached runtime process.                                    |
| `ensureAgentRuntime(options?)` | Starts the runtime only when `ping()` reports it unavailable.                  |
| `waitForAgentRuntimeReady()`   | Polls `ping()` until the runtime is ready or times out.                        |
| `ensureAgentReady(options?)`   | Runs auth and runtime checks together.                                         |

## Client API

```ts
new AgentRuntimeClient(dataDir: string)
```

Methods:

| Method                              | Description                                                      |
| ----------------------------------- | ---------------------------------------------------------------- |
| `ping(timeoutMs?)`                  | Checks runtime availability without requiring the runtime token. |
| `status(params?, options?)`         | Reads local status snapshots.                                    |
| `registerProject(params, options?)` | Registers a project through the runtime.                         |
| `listProjects(options?)`            | Lists registered local projects.                                 |
| `syncProject(params, options?)`     | Requests sync for one or more projects.                          |
| `unbindProject(params, options?)`   | Removes a local binding.                                         |
| `cleanProject(params, options?)`    | Cleans local project data.                                       |
| `searchHead(params, options?)`      | Searches indexed local HEAD content.                             |
| `shutdown(params, options?)`        | Requests runtime shutdown.                                       |

All methods accept an optional `{ timeoutMs }` option. The default request timeout is `30000ms`, except `ping`, which defaults to `1000ms`.

## Errors

`AgentRuntimeClientError` includes:

- `code`: stable error code such as `RUNTIME_UNAVAILABLE`, `TIMEOUT`, `BROKEN_PIPE`, `PROTOCOL_MISMATCH`, or `RPC_TRANSPORT_ERROR`.
- `retryable`: whether retrying may succeed.
- `details`: optional underlying error details.

Use `isRuntimeUnavailableError(error)` to handle missing or stopped runtimes.

## Protocol Types

The package exports protocol types for runtime operations, including:

- `AgentRuntimePingResult`
- `AgentRuntimeCapabilities`
- `AgentStatusSnapshot`
- `LocalProjectRecord`
- `RegisterProjectRpcParams`
- `SyncProjectRpcParams`
- `CleanProjectRpcParams`
- `SearchExactQuery`
- `SearchHeadRpcParams`
- `SearchHeadRpcResult`
- `SearchResponseMeta`
- `SearchResultItem`
- `SearchTarget`

It also exports `AGENT_RUNTIME_PROTOCOL_VERSION` and `isMutatingRpcMethod`.

## Technical Notes

- Package type: ESM.
- Runtime transport: newline-delimited JSON over a local Unix socket.
- Socket metadata is read from the agent data directory.
- The client validates socket ownership before sending requests.
- Mutating RPC methods require an idempotency key in their params.

## Development

From the repository root:

```sh
npm run build:agent-rpc
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/grepmind-ai/grepmind/issues).

## License

Apache-2.0

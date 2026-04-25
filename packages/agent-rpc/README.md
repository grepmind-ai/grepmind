# @grepmind/agent-rpc

Typed client for the local Grepmind agent runtime socket.

`@grepmind/agent-rpc` lets tools talk to a running `@grepmind/agent` runtime without importing the full runtime implementation. It exposes a small client, protocol constants, protocol types, and runtime-unavailable error helpers.

## Requirements

- Node.js 18 or newer.
- A running Grepmind agent runtime for the target data directory.

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

## Client API

```ts
new AgentRuntimeClient(dataDir: string)
```

Methods:

| Method | Description |
| --- | --- |
| `ping(timeoutMs?)` | Checks runtime availability without requiring the runtime token. |
| `status(params?, options?)` | Reads local status snapshots. |
| `registerProject(params, options?)` | Registers a project through the runtime. |
| `listProjects(options?)` | Lists registered local projects. |
| `syncProject(params, options?)` | Requests sync for one or more projects. |
| `unbindProject(params, options?)` | Removes a local binding. |
| `cleanProject(params, options?)` | Cleans local project data. |
| `searchHead(params, options?)` | Searches indexed local HEAD content. |
| `shutdown(params, options?)` | Requests runtime shutdown. |

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
- `AgentStatusSnapshot`
- `LocalProjectRecord`
- `RegisterProjectRpcParams`
- `SyncProjectRpcParams`
- `CleanProjectRpcParams`
- `SearchHeadRpcParams`
- `SearchHeadRpcResult`
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

Report bugs and request features through [GitHub Issues](https://github.com/zaytra-labs/grepmind/issues).

## License

Apache-2.0

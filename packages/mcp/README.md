# @grepmind/mcp

<!-- release: patch refresh -->

[Website](https://grepmind.ai)

Project-local MCP server for Grepmind-backed code and docs search.

`@grepmind/mcp` runs over stdio. One MCP server process is bound to one Git workspace, and the workspace is fixed during startup from the project-local launch directory.

## Requirements

- Node.js 18 or newer.
- A project-local MCP client configuration.
- A Git workspace with an `origin` remote when the workspace is not registered yet.
- A running Grepmind agent runtime for the same `GREPMIND_AGENT_DATA_DIR`.

The MCP package does not start the Grepmind agent runtime. Start the agent before starting the MCP client.

## Install

```sh
npm install -g @grepmind/mcp
```

## MCP Client Configuration

Recommended setup is to run the public CLI from the Git workspace:

```sh
grepmind init --codex
grepmind init --claude --yes
grepmind init --cursor --dry-run
```

`grepmind init` writes commit-safe `.grepmind.json` and updates the selected
project-local MCP client config without writing OAuth secrets or binding ids to
project files. `.grepmind.json` stores the backend hostname and optional
code/docs indexing rules only; generated files omit `code` and `docs` until you
add custom rules. MCP package, startup timeout, command, args, env, and
client-specific fields belong to the MCP client config. It registers or reuses
the current workspace unless `--dry-run` is passed.

Manual project-local stdio configuration:

```json
{
  "mcpServers": {
    "grepmind": {
      "command": "npx",
      "args": ["-y", "@grepmind/mcp@0.1.1"],
      "env": {
        "GREPMIND_MCP_STARTUP_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

Global MCP configuration without a workspace is not supported. For multiple repositories, configure one Grepmind MCP server instance per repository.

To update the package used by MCP client config, rerun `grepmind init --force
--mcp-package @grepmind/mcp@latest`.

## Startup Behavior

The MCP client is connected only after startup has completed all required preparation:

1. Resolve the Git workspace root from the project-local launch directory.
2. Connect to the already running local agent runtime.
3. Register the workspace if needed.
4. Resolve exactly one local project `bindingId`.
5. Connect stdio transport.

If the agent is not running, MCP startup fails with a command you can run manually, such as `grepmind agent run --detach --data-dir ~/.grepmind-agent`. Use `grepmind agent auth login --hostname <host>` before starting the agent when login or account selection is required.

Workspace registration happens only during startup. Tool calls do not choose repositories, run OAuth, start runtime, or register workspaces.

## Tools

This MCP server exposes `code_search` and `grepmind_agent_status`.

### `code_search`

Finds code or documentation in the startup workspace. Use `query` to describe
intent in natural language. When you know a concrete identifier, string, route,
config key, error text, import path, function name, or regex anchor, add
`exact.pattern` as an additional local signal.

Input fields:

| Field          | Type               | Description                                                                                                                  |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `query`        | `string`           | Natural-language search query.                                                                                               |
| `target`       | `"code" \| "docs"` | Optional target. Defaults to `code`.                                                                                         |
| `limit`        | `number`           | Optional maximum result count. Defaults to `10`.                                                                             |
| `threshold`    | `number`           | Optional semantic threshold from `0` to `1`. Defaults to `0.5`.                                                              |
| `rerank`       | `boolean`          | Ignored. Semantic reranking is disabled and requests always send `rerank=false`.                                             |
| `path`         | `string`           | Optional relative path prefix filter, such as `src/api`.                                                                     |
| `tags`         | `string[]`         | Optional docs tag filter.                                                                                                    |
| `exact`        | `object`           | Optional local exact search signal for `rg`: `pattern`, `regex`, `caseSensitive`. `pattern` may be a string or string array. |
| `globs`        | `string[]`         | Optional local `rg` glob scopes. Not raw `rg` flags.                                                                         |
| `contextLines` | `number`           | Optional local `rg` context lines. Defaults to `2`, maximum `10`.                                                            |
| `compact`      | `boolean`          | Optional compact output without full previews.                                                                               |

`workspacePath` is not accepted. The repository scope always comes from the server-side `bindingId` resolved during MCP startup.

Example tool input:

```json
{
  "query": "where repository settings are validated before save",
  "exact": {
    "pattern": ["safeParse", "z.object", "validate"]
  },
  "target": "code",
  "path": "packages/app/src",
  "limit": 20
}
```

Exact search is handled by the local agent runtime with system `rg` after the
current workspace HEAD has been resolved to an indexed revision. The backend
receives the semantic query only; it does not receive `exact.pattern`, `globs`,
local working tree context, or local `rg` matches. Exact search runs only inside
paths returned by semantic search and is added back as evidence on semantic
results. When `tags` are provided, local `rg` is skipped because tags are
semantic/docs chunk metadata. Exact search is case-insensitive by default; set
`exact.caseSensitive` to `true` for a case-sensitive local `rg` signal.

### `grepmind_agent_status`

Returns JSON diagnostics for the current MCP workspace:

- `workspacePath`
- `bindingId`
- `dataDir`
- auth status
- runtime status
- registered project
- latest sync/materialization status visible to the local runtime

## Environment Variables

| Variable                          | Description                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `GREPMIND_AGENT_DATA_DIR`         | Agent data directory. Defaults to `~/.grepmind-agent`.                         |
| `GREPMIND_MCP_STARTUP_TIMEOUT_MS` | Startup timeout for runtime connection and registration. Defaults to `120000`. |

The server also loads `.env` through `dotenv/config`.

## Technical Notes

- Package type: ESM.
- Binary: `grepmind-mcp`.
- MCP transport: stdio.
- MCP server name: `grepmind-search`.
- Startup does not block on a full sync. If the current HEAD is not indexed yet, `code_search` returns an index-not-ready error.

## Development

From the repository root:

```sh
npm run build:mcp
```

Run the built server from the repository root:

```sh
npm -w @grepmind/mcp run start
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/grepmind-ai/grepmind/issues).

## License

Apache-2.0

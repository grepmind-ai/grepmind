# @grepmind/mcp

MCP server for Grepmind-backed local search.

`@grepmind/mcp` runs over stdio and exposes tools that search the current indexed local HEAD through a running Grepmind agent runtime. It is intended for MCP clients that need semantic code or docs search over registered local workspaces.

## Requirements

- Node.js 18 or newer.
- A running Grepmind agent runtime.
- A registered and synced workspace.
- An MCP client that supports stdio servers.

## Install

```sh
npm install -g @grepmind/mcp
```

## Setup

Configure and start the local agent first:

```sh
grepmind agent configure --url https://your-grepmind-server.example
grepmind agent run -d
grepmind agent register --workspace ~/work/your-repo
```

Then run the MCP server:

```sh
grepmind-mcp
```

The server communicates over stdio, so it is normally launched by your MCP client rather than run directly in a terminal.

## MCP Client Configuration

Example stdio configuration:

```json
{
  "mcpServers": {
    "grepmind": {
      "command": "grepmind-mcp",
      "env": {
        "GREPMIND_AGENT_DATA_DIR": "/Users/you/.grepmind-agent"
      }
    }
  }
}
```

`GREPMIND_AGENT_DATA_DIR` is optional when the agent uses the default `~/.grepmind-agent` directory.

## Tools

### `code_search`

Finds code or documentation by describing what it does in natural language.

Input fields:

| Field           | Type               | Description                                                       |
| --------------- | ------------------ | ----------------------------------------------------------------- |
| `workspacePath` | `string`           | Absolute path to the registered workspace.                        |
| `query`         | `string`           | Natural-language search query.                                    |
| `target`        | `"code" \| "docs"` | Optional target. Defaults to `code`.                              |
| `limit`         | `number`           | Optional maximum result count. Defaults to `10`.                  |
| `threshold`     | `number`           | Optional similarity threshold from `0` to `1`. Defaults to `0.5`. |
| `path`          | `string`           | Optional relative path prefix filter, such as `src/api`.          |
| `tags`          | `string[]`         | Optional docs tag filter.                                         |
| `compact`       | `boolean`          | Optional compact output without full previews.                    |

Example tool input:

```json
{
  "workspacePath": "/Users/you/work/your-repo",
  "query": "validate user input before saving settings",
  "target": "code",
  "limit": 5,
  "path": "src"
}
```

## Environment Variables

| Variable                  | Description                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `GREPMIND_AGENT_DATA_DIR` | Agent data directory used to find the runtime socket. Defaults to `~/.grepmind-agent`. |

The server also loads `.env` through `dotenv/config`, so local environment files can provide the same value.

## Technical Notes

- Package type: ESM.
- Binary: `grepmind-mcp`.
- MCP transport: stdio.
- MCP server name: `grepmind-search`.
- Current tool surface: `code_search`.
- Search is delegated to `@grepmind/agent-rpc` and requires a running local runtime.

## Development

From the repository root:

```sh
npm run build:mcp
```

Run the built server:

```sh
npm -w @grepmind/mcp run start
```

## Support

Report bugs and request features through [GitHub Issues](https://github.com/zaytra-labs/grepmind/issues).

## License

Apache-2.0

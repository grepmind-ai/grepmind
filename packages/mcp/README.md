# @grepmind/mcp

Project-local MCP server for Grepmind-backed code and docs search.

`@grepmind/mcp` runs over stdio. One MCP server process is bound to one Git workspace, and the workspace is fixed during startup from the project-local launch directory.

## Requirements

- Node.js 18 or newer.
- A project-local MCP client configuration.
- A Git workspace with an `origin` remote when the workspace is not registered yet.

The MCP package includes the compatible `@grepmind/agent` runtime and starts it through the bundled package entrypoint. It does not depend on a global `grepmind-agent` binary.

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
project files. It starts or reuses the local Grepmind agent runtime and registers
or reuses the current workspace unless `--dry-run` is passed.

Manual project-local stdio configuration:

```json
{
  "mcpServers": {
    "grepmind": {
      "command": "npx",
      "args": ["-y", "@grepmind/mcp@0.1.1"],
      "env": {
        "GREPMIND_AGENT_HOSTNAME": "app.grepmind.ai",
        "GREPMIND_MCP_STARTUP_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

Global MCP configuration without a workspace is not supported. For multiple repositories, configure one Grepmind MCP server instance per repository.

To update the package used by project configs, rerun `grepmind init --force
--mcp-package @grepmind/mcp@latest`.

## Startup Behavior

The MCP client is connected only after startup has completed all required preparation:

1. Resolve the Git workspace root from the project-local launch directory.
2. Resolve the bundled `@grepmind/agent` CLI entrypoint.
3. Ensure Grepmind agent authentication.
4. Start or reuse the local agent runtime.
5. Register the workspace if needed.
6. Resolve exactly one local project `bindingId`.
7. Connect stdio transport.

If login is required, set `GREPMIND_AGENT_HOSTNAME` so MCP startup can open the OAuth flow. Startup is bounded by `GREPMIND_MCP_STARTUP_TIMEOUT_MS` and reports a pre-login command if OAuth or runtime startup takes too long. `grepmind init --yes --no-open` can be used to verify fully non-interactive readiness before starting an MCP client.

Workspace registration happens only during startup. Tool calls do not choose repositories, run OAuth, start runtime, or register workspaces.

## Tools

### `code_search`

Finds code or documentation in the startup workspace by describing what it does in natural language.

Input fields:

| Field       | Type               | Description                                                       |
| ----------- | ------------------ | ----------------------------------------------------------------- |
| `query`     | `string`           | Natural-language search query.                                    |
| `target`    | `"code" \| "docs"` | Optional target. Defaults to `code`.                              |
| `limit`     | `number`           | Optional maximum result count. Defaults to `10`.                  |
| `threshold` | `number`           | Optional similarity threshold from `0` to `1`. Defaults to `0.5`. |
| `path`      | `string`           | Optional relative path prefix filter, such as `src/api`.          |
| `tags`      | `string[]`         | Optional docs tag filter.                                         |
| `compact`   | `boolean`          | Optional compact output without full previews.                    |

`workspacePath` is not accepted. The repository scope always comes from the server-side `bindingId` resolved during MCP startup.

Example tool input:

```json
{
  "query": "validate user input before saving settings",
  "target": "code",
  "limit": 5,
  "path": "src"
}
```

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

| Variable                          | Description                                                         |
| --------------------------------- | ------------------------------------------------------------------- |
| `GREPMIND_AGENT_DATA_DIR`         | Agent data directory. Defaults to `~/.grepmind-agent`.              |
| `GREPMIND_AGENT_HOSTNAME`         | Grepmind hostname used when startup needs to run OAuth login.       |
| `GREPMIND_MCP_STARTUP_TIMEOUT_MS` | Startup timeout for auth/runtime preparation. Defaults to `120000`. |

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

# @grepmind/mcp

<!-- release: patch refresh -->

[Website](https://grepmind.ai)

Project-local MCP server for Grepmind-backed code and docs search.

`@grepmind/mcp` runs over stdio. One MCP server process is bound to one Git workspace, and the workspace is fixed during startup from the project-local launch directory.

## Requirements

- Node.js 18 or newer.
- A project-local MCP client configuration.
- A Git workspace with an `origin` remote when the workspace is not registered yet.
- Codex CLI for the optional `context_layer` tool.

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
project files. `.grepmind.json` stores the backend hostname and optional
code/docs indexing rules only; generated files omit `code` and `docs` until you
add custom rules. MCP package, startup timeout, command, args, env, and
client-specific fields belong to the MCP client config. It starts or reuses the
local Grepmind agent runtime and registers or reuses the current workspace
unless `--dry-run` is passed.

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

To update the package used by MCP client config, rerun `grepmind init --force
--mcp-package @grepmind/mcp@latest`.

For Codex, `grepmind init --codex` writes `tool_timeout_sec = 210` so the
longer-running `context_layer` tool can return its own timeout or result before
the MCP client cancels the call.

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

Use `code_search` for quick semantic or exact retrieval. Use `context_layer`
when the agent needs a curated multi-file or multi-doc `context_pack` before a
larger implementation, debugging, architecture, or review task.

### `code_search`

Finds code or documentation in the startup workspace. Use `query` to describe
intent in natural language. When you know a concrete identifier, string, route,
config key, error text, import path, function name, or regex anchor, add
`exact.pattern` as an additional local signal.

Input fields:

| Field          | Type               | Description                                                                       |
| -------------- | ------------------ | --------------------------------------------------------------------------------- |
| `query`        | `string`           | Natural-language search query.                                                    |
| `target`       | `"code" \| "docs"` | Optional target. Defaults to `code`.                                              |
| `limit`        | `number`           | Optional maximum result count. Defaults to `10`.                                  |
| `threshold`    | `number`           | Optional semantic threshold from `0` to `1`. Defaults to `0.5`.                   |
| `path`         | `string`           | Optional relative path prefix filter, such as `src/api`.                          |
| `tags`         | `string[]`         | Optional docs tag filter.                                                         |
| `exact`        | `object`           | Optional local exact search signal for `rg`: `pattern`, `regex`, `caseSensitive`. |
| `globs`        | `string[]`         | Optional local `rg` glob scopes. Not raw `rg` flags.                              |
| `contextLines` | `number`           | Optional local `rg` context lines. Defaults to `2`, maximum `10`.                 |
| `compact`      | `boolean`          | Optional compact output without full previews.                                    |

`workspacePath` is not accepted. The repository scope always comes from the server-side `bindingId` resolved during MCP startup.

Example tool input:

```json
{
  "query": "where repository settings are validated before save",
  "exact": {
    "pattern": "safeParse|z\\.object|validate",
    "regex": true
  },
  "target": "code",
  "path": "packages/app/src",
  "limit": 20
}
```

Exact search is handled by the local agent runtime with system `rg` after the
current workspace HEAD has been resolved to an indexed revision. The backend
receives the semantic query only; it does not receive `exact.pattern`, `globs`,
local working tree context, or local `rg` matches. When `tags` are provided,
local `rg` is skipped because tags are semantic/docs chunk metadata. Exact
search is case-insensitive by default; set `exact.caseSensitive` to `true` for a
case-sensitive local `rg` signal.

### `context_layer`

Runs a read-only Codex CLI subagent in the startup workspace and asks it to
prepare a markdown `context_pack`. The subagent can call Grepmind `code_search`
itself, inspect local files with read-only commands such as `rg`, `sed`, and
`nl`, and then return a curated map of code, docs, flow, evidence, risks, and
suggested next edits.

`context_layer` is not a search mode and does not run `code_search` before the
subagent starts. Retrieval remains inside the subagent's reasoning loop.

Input fields:

| Field            | Type                                                            | Description                                        |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `query`          | `string`                                                        | Task or code question to research.                 |
| `model.provider` | `"codex" \| "claude"`                                           | Optional provider. MVP supports `codex` only.      |
| `model.name`     | `string`                                                        | Optional Codex model name. Defaults to `fast`.     |
| `model.thinking` | `"low" \| "medium" \| "high"`                                   | Optional Codex reasoning effort. Defaults `low`.   |
| `model.speed`    | `"fast"`                                                        | Reserved speed profile.                            |
| `maxFiles`       | `number`                                                        | Optional deep-inspection limit. Defaults to `30`.  |
| `maxSearchCalls` | `number`                                                        | Optional search-call budget. Defaults to `8`.      |
| `focus`          | `"implementation" \| "debugging" \| "architecture" \| "review"` | Optional task focus. Defaults to `implementation`. |

Example tool input:

```json
{
  "query": "trace where user input is validated before saving settings",
  "model": {
    "provider": "codex",
    "name": "fast",
    "thinking": "low",
    "speed": "fast"
  },
  "maxSearchCalls": 8,
  "focus": "implementation"
}
```

Expected output headings:

```md
# context_pack

## Short Answer

## Code Context

## Docs Context

## Flow

## Evidence

## Risks And Gaps

## Suggested Next Edits
```

Requirements and safety:

- Codex CLI must be installed or `GREPMIND_CONTEXT_LAYER_CODEX_BIN` must point
  to a compatible binary.
- `$CODEX_HOME/grepmind-context-layer-subagent.config.toml` must exist.
- The subagent profile or project `.codex/config.toml` must keep Grepmind MCP
  available so the subagent can call `code_search`.
- Before launching the LLM subagent, the runner checks the profile file directly
  and verifies `codex mcp list --json` exposes an enabled `grepmind` server for
  the startup workspace.
- The runner starts Codex with `--sandbox read-only`, `--ephemeral`,
  `--ask-for-approval never`, and `GREPMIND_CONTEXT_LAYER_SUBAGENT=1`.
- `context_layer` is hidden inside a context-layer subagent process, while
  `code_search` remains available.
- The subagent is instructed not to edit files, run tests, run `tsc`, install
  dependencies, start dev servers, kill processes, or run destructive git
  operations.
- The returned `context_pack` is validated before the MCP response is sent. It
  must contain exactly the documented headings in order, with non-empty sections.

If `model.provider` is `claude`, the tool returns
`CLAUDE_RUNTIME_NOT_IMPLEMENTED` until a Claude runtime is implemented.

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

| Variable                                  | Description                                                         |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `GREPMIND_AGENT_DATA_DIR`                 | Agent data directory. Defaults to `~/.grepmind-agent`.              |
| `GREPMIND_AGENT_HOSTNAME`                 | Grepmind hostname used when startup needs to run OAuth login.       |
| `GREPMIND_MCP_STARTUP_TIMEOUT_MS`         | Startup timeout for auth/runtime preparation. Defaults to `120000`. |
| `GREPMIND_CONTEXT_LAYER_PROVIDER`         | Default context-layer provider. MVP supports `codex`.               |
| `GREPMIND_CONTEXT_LAYER_CODEX_MODEL`      | Default Codex model name for `context_layer`. Defaults to `fast`.   |
| `GREPMIND_CONTEXT_LAYER_CODEX_THINKING`   | Default Codex reasoning effort: `low`, `medium`, or `high`.         |
| `GREPMIND_CONTEXT_LAYER_CODEX_SPEED`      | Reserved speed profile. Must be `fast`.                             |
| `GREPMIND_CONTEXT_LAYER_CODEX_BIN`        | Optional path to the Codex CLI binary.                              |
| `GREPMIND_CONTEXT_LAYER_TIMEOUT_MS`       | Subagent process timeout. Defaults to `180000`, max `600000`.       |
| `GREPMIND_CONTEXT_LAYER_MAX_OUTPUT_BYTES` | Response byte limit before truncation. Defaults to `400000`.        |
| `GREPMIND_CONTEXT_LAYER_LOG`              | Set to `1` to log safe context-layer counters to stderr.            |

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

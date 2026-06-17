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

For Codex, `grepmind init --codex` writes a `tool_timeout_sec` value that
covers the prompt-refiner timeout, the research timeout, and a buffer so the
longer-running `context_layer` tool can return its own timeout or result before
the MCP client cancels the call. With default budgets this value is `255`.

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
larger implementation, debugging, architecture, or review task. `context_layer`
always runs a prompt-refiner subagent before research; if the refiner needs
caller context, the tool returns `# agent_questions` instead of starting
research.

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

Runs a prompt-refiner Codex CLI subagent first, then a read-only Codex CLI
research subagent in the startup workspace after the refined query is ready. The
research subagent can call Grepmind `code_search` itself, including optional
exact local `rg` signal through `exact`, `globs`, and `contextLines`, and then
return a curated map of code, docs, flow, evidence, risks, and suggested edit
surfaces.

`context_layer` is not a search mode and does not run `code_search` before the
research subagent starts. Retrieval remains inside the research subagent's
reasoning loop. The prompt-refiner is instructed not to inspect the repository
and runs with a dedicated Codex profile.

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
| `refinementSession` | `string`                                                     | Continue a prompt-refinement session.              |
| `agentAnswers`   | `{ questionId: string, answer: string }[]`                      | Answers from the calling agent for a session.      |

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

If the prompt-refiner needs more context from the calling agent, the output is a
normal non-error `agent_questions` result:

```md
# agent_questions

Refinement session: clr_...

## Refined Query Draft

...

## Questions For Calling Agent

1. q1: Which existing conversation constraint should the research agent preserve?
   Reason: The original task references prior context not present in the query.
   Expected answer: A concise summary of the constraint from the calling agent's state.
```

Repeat the tool call with the session key and answers from the calling agent:

```json
{
  "query": "same task, continuing refinement",
  "refinementSession": "clr_...",
  "agentAnswers": [
    {
      "questionId": "q1",
      "answer": "The caller already inspected context_layer.ts and wants an implementation plan, not code changes."
    }
  ]
}
```

A repeated call with a valid `refinementSession` and no new `agentAnswers`
returns the cached `agent_questions` result without running the refiner again.
Refinement sessions are in-memory, expire after 30 minutes by default, and do
not survive MCP process restarts. Once research starts, the `context_pack`
format remains unchanged.

Expected output headings:

```md
# context_pack

## Short Answer

## Code Context

## Docs Context

## Flow
```

Requirements and safety:

- Codex CLI must be installed or `GREPMIND_CONTEXT_LAYER_CODEX_BIN` must point
  to a compatible binary.
- `$CODEX_HOME/grepmind-context-layer-refiner.config.toml` must be configured
  as a valid profile for prompt refinement.
- `$CODEX_HOME/grepmind-context-layer-subagent.config.toml` must exist.
- The subagent profile or project `.codex/config.toml` must keep Grepmind MCP
  available so the subagent can call `code_search`.
- Before launching the prompt-refiner, the runner verifies
  `codex mcp list --json` can load the refiner profile.
- Before launching the LLM subagent, the runner checks the profile file directly
  and verifies `codex mcp list --json` exposes an enabled `grepmind` server for
  the startup workspace.
- The runner starts Codex with `--sandbox read-only`, `--ephemeral`,
  `--ask-for-approval never`, and `GREPMIND_CONTEXT_LAYER_SUBAGENT=1`.
- `context_layer` is hidden inside a context-layer subagent process, while
  `code_search` remains available.
- The subagent is instructed to use only `code_search` for repository research,
  not direct shell/filesystem inspection, and not to edit files, run tests, run
  `tsc`, install dependencies, start dev servers, kill processes, or run
  destructive git operations.
- The returned `context_pack` is validated before the MCP response is sent. It
  must contain exactly the documented headings in order, with non-empty sections.
  Evidence snippets from `code_search` are embedded in the relevant sections
  instead of a separate heading. Gaps and suggested edit surfaces are embedded
  beside the related code, docs, or flow items.

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
| `GREPMIND_CONTEXT_LAYER_PROMPT_REFINER_TIMEOUT_MS` | Prompt-refiner timeout. Defaults to `45000`, max `120000`. |
| `GREPMIND_CONTEXT_LAYER_TIMEOUT_MS`       | Research subagent process timeout. Defaults to `180000`, max `600000`. |
| `GREPMIND_CONTEXT_LAYER_MAX_OUTPUT_BYTES` | Response byte limit before truncation. Defaults to `400000`.        |
| `GREPMIND_CONTEXT_LAYER_REFINEMENT_TTL_MS` | In-memory refinement session TTL. Defaults to 30 minutes, max 24 hours. |
| `GREPMIND_CONTEXT_LAYER_MAX_REFINEMENT_SESSIONS` | Max in-memory refinement sessions. Defaults to `100`.       |
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

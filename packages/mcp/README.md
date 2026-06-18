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
the MCP client cancels the call. With default budgets this value is `375`.

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
| `rerank`       | `boolean`          | Optional semantic reranking. Defaults to `false`.                                 |
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

Runs a prompt-refiner Codex CLI subagent first. After the refined query is
ready, the MCP handler starts one read-only Codex CLI research subagent in the
startup workspace. That same subagent performs bounded Grepmind `code_search`
retrieval, including optional exact local `rg` signal through `exact`, `globs`,
and `contextLines`, reads repository files as needed, and performs the final
verification/aggregation pass before returning the `context_pack`.

The handler runs Codex with JSONL stdout and `--output-last-message` together:
the final subagent answer is read from the output file so large answers are not
read from a truncated diagnostic tail, while token usage is collected from the
`turn.completed.usage` JSONL event.

The research subagent returns a `Sufficiency` decision and may suggest precise
next queries, but the MCP handler does not automatically run another retrieval
iteration. The final result is a curated map of code, docs, flow, sufficiency,
evidence quality, risks, and suggested edit surfaces. The prompt-refiner is
instructed not to inspect the repository and runs with Grepmind MCP disabled.
The prompt-refiner writes `refinedQuery` and `refinedQueryDraft` in English
regardless of the caller's language, while preserving literal identifiers,
paths, routes, config keys, exact strings, and error messages.

All context-layer Codex subagents use the fixed `gpt-5.5` model. The
prompt-refiner subagent uses medium reasoning effort, and the research subagent
uses low reasoning effort.

Input fields:

| Field               | Type                                                            | Description                                        |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `query`             | `string`                                                        | Task or code question to research.                 |
| `maxSearchCalls`    | `number`                                                        | Optional research subagent `code_search` budget. Defaults to `8`. |
| `focus`             | `"implementation" \| "debugging" \| "architecture" \| "review"` | Optional task focus. Defaults to `implementation`. |
| `refinementSession` | `string`                                                        | Continue a prompt-refinement session.              |
| `agentAnswers`      | `{ questionId: string, answer: string }[]`                      | Answers from the calling agent for a session.      |

Example tool input:

```json
{
  "query": "trace where user input is validated before saving settings",
  "maxSearchCalls": 8,
  "focus": "implementation"
}
```

If the prompt-refiner needs more context from the calling agent, the output is a
normal non-error `agent_questions` result:

```md
# agent_questions

Refinement session: clr\_...

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
not survive MCP process restarts.

Expected response headings:

```md
# context_layer_run

## Research Prompt After Refinement

## Answer

## Evidence

### Evidence Quality

### Sufficiency

### Code Context

### Docs Context

### Flow
```

The `context_layer_run` header includes the research model, reasoning effort,
research token usage, truncation status, and the full `context_pack` path when the MCP
response had to be compacted. The prompt block shown in the response contains
only `Refined user query:` and the refined query passed into the read-only
research subagent prompt. The rendered response separates the concise `Answer`
from attached `Evidence`; it does not repeat the raw `# context_pack` or the
`Answer` section inside the evidence block.

Raw research subagent output is still validated against this `context_pack`
contract before the handler adds the run header and refined research prompt:

```md
# context_pack

## Answer

## Evidence Quality

## Sufficiency

## Code Context

## Docs Context

## Flow
```

Requirements and safety:

- Codex CLI must be installed or `GREPMIND_CONTEXT_LAYER_CODEX_BIN` must point
  to a compatible binary.
- `$CODEX_HOME/grepmind-context-layer-subagent.config.toml` must exist.
- The research subagent may call Grepmind `code_search`. `context_layer` is not
  registered inside context-layer subagent processes.
- Before launching the LLM subagent, the runner checks the profile file directly.
- The runner starts Codex with `--json`, `--sandbox read-only`, `--ephemeral`,
  `--ask-for-approval never`, and `GREPMIND_CONTEXT_LAYER_SUBAGENT=1`.
- The prompt-refiner still runs with Grepmind MCP disabled; only the research
  subagent can use `code_search`.
- Subagent prompts explicitly forbid `context_layer` and nested agents to avoid
  recursive retrieval loops.
- Safety constraints are enforced by the Codex runner/profile instead of being
  repeated as task text inside context-layer prompts.
- The returned `context_pack` is validated before the MCP response is sent. It
  must contain exactly the documented headings in order, with non-empty sections.
  `Evidence Quality` must include proven anchors, inferences, gaps, failed or
  truncated summaries, and an explicit `Confidence: high|medium|low` line.
  `Sufficiency` must include `Enough to answer: yes|no`, missing context, and
  suggested next context queries. The handler appends a short debug log there
  with iteration and subagent counts. `Code Context` and `Docs Context` are the
  evidence registers: each code/doc anchor gets one stable ID such as `[E1]` or
  `[D1]`, while `Answer`, `Evidence Quality`, `Sufficiency`, and `Flow` cite
  those IDs instead of repeating file:line anchors or snippets.

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

| Variable                                           | Description                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `GREPMIND_AGENT_DATA_DIR`                          | Agent data directory. Defaults to `~/.grepmind-agent`.                  |
| `GREPMIND_AGENT_HOSTNAME`                          | Grepmind hostname used when startup needs to run OAuth login.           |
| `GREPMIND_MCP_STARTUP_TIMEOUT_MS`                  | Startup timeout for auth/runtime preparation. Defaults to `120000`.     |
| `GREPMIND_CONTEXT_LAYER_CODEX_BIN`                 | Optional path to the Codex CLI binary.                                  |
| `GREPMIND_CONTEXT_LAYER_PROMPT_REFINER_TIMEOUT_MS` | Prompt-refiner timeout. Defaults to `45000`, max `120000`.              |
| `GREPMIND_CONTEXT_LAYER_TIMEOUT_MS`                | Research subagent process timeout. Defaults to `300000`, max `600000`.  |
| `GREPMIND_CONTEXT_LAYER_MAX_OUTPUT_BYTES`          | Response byte limit before truncation. Defaults to `400000`.            |
| `GREPMIND_CONTEXT_LAYER_REFINEMENT_TTL_MS`         | In-memory refinement session TTL. Defaults to 30 minutes, max 24 hours. |
| `GREPMIND_CONTEXT_LAYER_MAX_REFINEMENT_SESSIONS`   | Max in-memory refinement sessions. Defaults to `100`.                   |
| `GREPMIND_CONTEXT_LAYER_LOG`                       | Set to `1` to log safe context-layer counters to stderr.                |

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

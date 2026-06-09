# Plan: `grepmind init` for project-local MCP setup

## Goal

Add a public command:

```sh
grepmind init
```

The command is the Grepmind MCP onboarding flow for local search. It configures the current Git workspace for a selected MCP client without storing secrets in project files.

The implementation must:

- work only in project scope;
- reuse the existing Grepmind agent OAuth flow;
- start or reuse the local Grepmind agent runtime when not in dry-run mode;
- register or reuse the current Git workspace binding when not in dry-run mode;
- write the canonical project config `.grepmind.json`;
- write or update the selected project-local MCP client config;
- be idempotent on rerun;
- preserve unrelated MCP server entries and unrelated config keys.

Code anchors:

- public CLI entrypoint: `packages/grepmind/src/index.ts`;
- deploy command argument and prompt style: `packages/grepmind/src/deploy.ts`;
- current MCP workspace root resolver: `packages/mcp/src/workspace.ts`;
- current MCP auth/runtime/register flow: `packages/mcp/src/runtime-context.ts`;
- agent runtime bootstrap exports: `packages/agent-rpc/src/bootstrap.ts`;
- agent-rpc public exports: `packages/agent-rpc/src/index.ts`.

Readiness criteria:

- The command contract is specific enough to implement without new product decisions.
- The implementation reuses existing code paths where current code already has the behavior.
- No part of the plan requires editing `AGENTS.md`, rules, skills, or `.changeset/*.md` by hand.

## Non-goals

- Do not support global setup.
- Do not bring back API key setup. Grepmind agent auth uses OAuth.
- Do not edit `AGENTS.md`, rules, or skills.
- Do not add hosted HTTP MCP. The current `@grepmind/mcp` runs over stdio.
- Do not support multiple workspaces in one MCP server instance.
- Do not store OAuth tokens, refresh tokens, account session tokens, selected account tokens, or machine-specific secure storage keys in the project.

Readiness criteria:

- `--global` fails with `grepmind init only supports project scope`.
- `--project` is accepted as a no-op compatibility flag.
- All writes are under the resolved Git workspace root.

## Current State In Code

`packages/grepmind/src/index.ts` currently supports:

- `grepmind auth ...`, proxied to `@grepmind/agent`;
- `grepmind agent ...`, proxied to `@grepmind/agent`;
- `grepmind deploy ...`, handled locally.

There is no `grepmind init` command.

`packages/mcp/src/workspace.ts` resolves the workspace with:

```sh
git -C <cwd> rev-parse --show-toplevel
```

So `grepmind init` must be runnable from any directory inside a Git workspace, then write project files at the resolved Git root.

`packages/mcp/src/runtime-context.ts` already contains most of the runtime setup algorithm:

- resolves the bundled `@grepmind/agent` command;
- calls `getAgentAuthStatus(...)`;
- calls `ensureAgentReady(...)`;
- creates `AgentRuntimeClient`;
- computes a workspace fingerprint;
- finds an existing local binding by path, realpath, or fingerprint;
- registers the workspace if no binding exists.

`packages/agent-rpc/src/index.ts` does not currently export workspace registration helpers. It exports `AgentRuntimeClient`, `ensureAgentReady`, `getAgentAuthStatus`, and related bootstrap types.

Readiness criteria:

- Implementation begins by extracting shared workspace registration helpers into `@grepmind/agent-rpc`.
- `@grepmind/mcp` is updated to consume the shared helper so `init` and MCP startup use one algorithm.

## Command UX

### Interactive run

```sh
grepmind init
```

Behavior:

1. Resolve the Git root from cwd using the same model as `packages/mcp/src/workspace.ts`.
2. Load existing `.grepmind.json` from the Git root if present.
3. Resolve hostname.
4. Detect project-local MCP client configs.
5. Select target clients.
6. If not in dry-run mode, ensure agent auth and runtime readiness.
7. If not in dry-run mode, register or reuse the workspace binding.
8. Write `.grepmind.json`.
9. Write selected MCP client configs.
10. Print a concise summary with written paths and next steps.

### Non-interactive run

```sh
grepmind init --codex --yes
```

`--yes` disables terminal prompts and confirmations. It does not forbid the OAuth browser flow.

Fully non-interactive mode is:

```sh
grepmind init --codex --yes --no-open
```

In fully non-interactive mode, the command must not ask questions, open a browser, or wait for account selection. If required auth/account state is missing, it fails with a clear error.

### Dry run

```sh
grepmind init --codex --dry-run
```

`--dry-run` has no side effects:

- no file writes;
- no OAuth login;
- no browser open;
- no agent runtime start;
- no workspace registration;
- no changeset generation.

It may read the Git root, existing `.grepmind.json`, and existing MCP client config files. It prints the planned files and the normalized entries that would be written.

### Flags

```text
--hostname <host>                 Grepmind backend hostname, default app.grepmind.ai, without scheme/path
--codex                           configure Codex project config
--claude                          configure Claude project config
--cursor                          configure Cursor project config
--all-detected                    configure all autodetected supported agents
-y, --yes                         do not ask terminal prompt/confirmation questions
--no-open                         do not automatically open the browser during OAuth
--data-dir <dir>                  Grepmind agent data dir
--mcp-package <pkg>               override MCP package spec, default @grepmind/mcp@<current>
--mcp-startup-timeout-ms <ms>     env GREPMIND_MCP_STARTUP_TIMEOUT_MS for the MCP entry
--force                           replace the existing grepmind MCP entry command/args without confirmation
--dry-run                         show planned writes without side effects
--project                         no-op compatibility flag
--global                          unsupported, fail
```

Flag conflict rules:

- Multiple explicit client flags are allowed and configure all selected clients.
- `--all-detected` must not be combined with explicit client flags.
- In the initial delivery, `--opencode` and `--gemini` are not supported flags and must fail before side effects with a message that support is planned for phase 2.
- `--global` fails even if combined with `--project`.
- `--no-open` is valid with or without `--yes`, but it only matters when OAuth/account selection is required.
- Unknown flags fail before any side effects.

Readiness criteria:

- `grepmind init --help` documents all supported flags and conflict rules.
- In `--yes` mode, every missing required value must either have a deterministic default or produce a clear error.
- In `--dry-run` mode, command output is enough to inspect intended writes without mutating files or runtime state.

## Hostname Resolution

Resolve hostname strictly in this order:

1. `--hostname`;
2. existing `.grepmind.json.hostname`;
3. `app.grepmind.ai`.

Validation rules:

- input must be a host with optional port;
- trim surrounding whitespace;
- reject values containing a URL scheme, path, query, or hash;
- preserve the provided casing in the file, but compare hostnames case-insensitively for confirmation/mismatch checks;
- allow localhost-style values such as `127.0.0.1:5173` and `localhost:5173`.

Existing agent auth config must not affect hostname resolution for a new project. If a self-hosted backend is needed, the user must pass `--hostname <host>` or have it in `.grepmind.json`.

Auth host mismatch rule:

- If the selected agent data dir is already logged in for the resolved hostname, continue.
- If the selected agent data dir is logged in for a different hostname:
  - interactive mode asks whether to run OAuth login for the resolved hostname;
  - `--yes` runs OAuth login for the resolved hostname unless `--no-open` is also set;
  - `--yes --no-open` fails with a clear message explaining the current host and required host.

Readiness criteria:

- Hostname normalization and validation are implemented in one helper.
- Existing `.grepmind.json.hostname` is never silently reset to default.
- Host mismatch behavior is tested manually through dry-run output and non-interactive error paths.

## Project Config

There is exactly one supported Grepmind project config file:

```text
.grepmind.json
```

It lives at the resolved Git root.

The file is intended to be commit-safe. It must not contain:

- OAuth access token;
- refresh token;
- account session token;
- account session metadata;
- absolute workspace path by default;
- `GREPMIND_AGENT_DATA_DIR` by default;
- binding id;
- machine-specific secure storage key.

Schema v1:

```json
{
  "$schema": "https://grepmind.dev/schemas/grepmind-project-config.v1.json",
  "version": 1,
  "hostname": "app.grepmind.ai",
  "mcp": {
    "serverName": "grepmind",
    "package": "@grepmind/mcp@0.1.1",
    "startupTimeoutMs": 120000
  }
}
```

Rerun behavior:

- preserve unknown top-level keys;
- update only known keys: `$schema`, `version`, `hostname`, `mcp`;
- preserve unknown nested keys under `mcp` only if they are not in the known v1 fields;
- if hostname changes, interactive mode asks for confirmation;
- in `--yes` mode, use the resolved hostname without prompting;
- do not write `.grepmind.json` in `--dry-run`.

Readiness criteria:

- Invalid JSON fails with a clear path-specific error.
- The writer pretty-prints JSON with 2 spaces.
- A second run with the same inputs produces no semantic changes.

## Agent Detection And Selection

Detection checks project-local files/directories under the resolved Git root.

Signals:

| Agent | Detection |
| --- | --- |
| Codex | `.codex/` or `.codex/config.toml` |
| Claude | `.mcp.json` or `.claude/` |
| Cursor | `.cursor/` or `.cursor/mcp.json` |
| OpenCode | `opencode.json`, `opencode.jsonc`, `.opencode.json`, `.opencode.jsonc` |
| Gemini CLI | `.gemini/` or `.gemini/settings.json` |

Selection rules:

1. If explicit client flags are provided, use all explicit clients.
2. If `--all-detected` is provided, use all detected supported clients.
3. If `--yes` is set and no explicit client flags are provided, use all detected supported clients.
4. If `--yes` is set and no supported clients are detected, fail and ask for explicit client flags.
5. If `--yes` is not set and detected clients exist with TTY available, show a prompt preselecting all detected supported clients.
6. If `--yes` is not set and nothing is detected with TTY available, show the full supported client list.
7. If no client can be selected without a prompt and TTY is unavailable, fail and ask for explicit client flags.

For the initial delivery, supported clients are Codex, Claude, and Cursor. OpenCode and Gemini detection is phase 2 and must not be selected automatically by `--yes` or `--all-detected` until their writers are implemented. Passing `--opencode` or `--gemini` in the initial delivery fails before side effects.

Prompt implementation must use `node:readline/promises`, matching the existing dependency-free style in `packages/grepmind/src/deploy.ts`.

Readiness criteria:

- Selection is deterministic in non-interactive mode.
- `grepmind init --yes` configures every detected supported client.
- `grepmind init --yes` fails clearly when no supported clients are detected.
- Detection never scans outside the Git root.
- Detection alone does not create directories.

## OAuth And Agent Readiness

`grepmind init` must reuse the existing OAuth and runtime bootstrap flow instead of implementing a second OAuth flow.

Implementation path:

1. Add a direct dependency from `grepmind` to `@grepmind/agent-rpc`.
2. Add a bundled agent command resolver in `packages/grepmind/src/init/agent-command.ts`, analogous to `resolveBundledAgentCommand()` in `packages/mcp/src/runtime-context.ts`.
3. Call `getAgentAuthStatus(dataDir)` before `ensureAgentReady(...)` to enforce hostname mismatch rules.
4. In non-dry-run mode, call:

```ts
await ensureAgentReady({
  dataDir,
  hostname,
  noOpen,
  timeoutMs,
  command: bundledAgentCommand
});
```

This provides:

- OAuth Authorization Code + PKCE when needed;
- browser account selection when allowed;
- secure credential storage;
- non-secret `~/.grepmind-agent/agent-config.json`;
- started/reused local runtime.

`grepmind init` does not expose an agent name override. The existing agent auth flow keeps its default local agent display name, which is the machine hostname unless the agent config already has a name.

Readiness criteria:

- `--dry-run` never calls `ensureAgentReady`.
- `--yes --no-open` fails instead of waiting when login/account selection is required.
- Runtime timeout and auth errors are normalized into user-facing messages.

## Workspace Registration

Move the registration algorithm from `packages/mcp/src/runtime-context.ts` into `@grepmind/agent-rpc`, then make both MCP startup and `grepmind init` call the shared helper.

New export from `@grepmind/agent-rpc`:

```ts
export async function ensureWorkspaceRegistered(options: {
  client: AgentRuntimeClient;
  workspacePath: string;
  displayName?: string;
  preferredActiveBranch?: string;
  idempotencyPrefix?: string;
  timeoutMs?: number;
}): Promise<LocalProjectRecord>;
```

Helper algorithm:

1. Resolve `workspacePath`.
2. Compute `workspaceFingerprint` using `realpath`, `stat.dev`, `stat.ino`, and `sha256`.
3. Call `client.listProjects()`.
4. Find existing records by:
   - exact normalized `workspacePath`;
   - matching `realpath`;
   - matching `workspaceFingerprint`.
5. If exactly one binding is found, return it.
6. If multiple bindings are found, throw an error asking the user to clean/unbind manually.
7. If no binding is found:
   - read `git remote get-url origin`;
   - derive `repoFullName` from remote URL when possible;
   - read default branch from `refs/remotes/origin/HEAD`;
   - read current branch from `git branch --show-current`;
   - call `client.registerProject(...)`.

Idempotency key:

```text
<idempotencyPrefix>:<sha256(workspaceFingerprint + "\0" + remoteUrl)>
```

Defaults:

- MCP startup uses `mcp-register`;
- `grepmind init` uses `init-register`;
- callers may pass a prefix only to identify the initiating flow, not to change workspace identity.

`grepmind init` must not write runtime registration state to `.grepmind.json`.

Readiness criteria:

- `packages/mcp/src/runtime-context.ts` no longer owns duplicated workspace registration logic.
- Shared helper preserves current MCP matching semantics.
- Missing `origin` fails clearly only when registration is actually needed.
- `--dry-run` does not call `client.listProjects()` or `registerProject(...)`.

## MCP Package Version

Default MCP package spec:

```text
@grepmind/mcp@<current-compatible-version>
```

For the current repository state, the version is `@grepmind/mcp@0.1.1`, from `packages/mcp/package.json`.

Implementation decision:

- Use a build-time constant generated or imported by the `grepmind` package build from workspace package metadata.
- Do not add `@grepmind/mcp` as a runtime dependency of `grepmind` just to read its version.

Override:

```sh
grepmind init --codex --mcp-package @grepmind/mcp@latest
grepmind init --codex --mcp-package file:../mcp
```

Readiness criteria:

- Default generated config pins the compatible MCP package version.
- `--mcp-package` is copied verbatim into MCP command args after basic non-empty validation.
- Docs explain that rerunning `grepmind init --force` can update the MCP command package.

## MCP Launch Command

Default project MCP command:

```json
{
  "command": "npx",
  "args": ["-y", "@grepmind/mcp@0.1.1"]
}
```

Reasoning:

- The user may run `npx grepmind init` without a global install.
- The MCP client starts later and does not need the same npm binary that ran `init`.
- `npx -y @grepmind/mcp@<version>` pulls a package that carries a compatible bundled `@grepmind/agent`.

Readiness criteria:

- Default command is `npx`.
- Default args are `["-y", <mcp package spec>]`.
- Existing recognized Grepmind local dev commands are preserved unless `--force` is passed.

## MCP Env

Every generated MCP entry must pass:

```text
GREPMIND_AGENT_HOSTNAME=<hostname>
GREPMIND_MCP_STARTUP_TIMEOUT_MS=<timeout>
```

Only if the user passed `--data-dir`, add:

```text
GREPMIND_AGENT_DATA_DIR=<dataDir>
```

`GREPMIND_AGENT_DATA_DIR` is intentionally omitted by default to avoid writing a machine-specific absolute path into project config.

Readiness criteria:

- Env values are strings in generated MCP configs.
- `mcp.startupTimeoutMs` in `.grepmind.json` and `GREPMIND_MCP_STARTUP_TIMEOUT_MS` remain consistent.
- Codex `startup_timeout_sec` is `Math.ceil(startupTimeoutMs / 1000)`.

## MCP Client Documentation Snapshot

Verified on 2026-06-09. Implement writers from this snapshot; do not re-open client docs during implementation unless a local config format contradicts these rules.

Sources:

- Codex MCP manual: `https://developers.openai.com/codex/mcp`
- Codex project config manual: `https://developers.openai.com/codex/config-advanced`
- Claude Code MCP docs: `https://code.claude.com/docs/en/mcp`
- Cursor MCP docs: `https://docs.cursor.com/context/model-context-protocol`
- OpenCode MCP docs: `https://opencode.ai/docs/mcp-servers`
- Gemini CLI MCP docs: `https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md`

Client-specific setup facts:

| Client | Project config | Entry container | Stdio fields to generate | Notes |
| --- | --- | --- | --- | --- |
| Codex | `.codex/config.toml` | `[mcp_servers.grepmind]` | `command`, `args`, `cwd`, `startup_timeout_sec`, `tool_timeout_sec`, nested `env` table | Project config loads only for trusted projects. CLI and IDE extension share the same config. |
| Claude Code | `.mcp.json` | `mcpServers.grepmind` | `command`, `args`, `env` | Project-scoped servers are version-control friendly but Claude prompts for approval before first use. Env expansion supports `${VAR}` and `${VAR:-default}` in `command`, `args`, `env`, `url`, and `headers`. |
| Cursor | `.cursor/mcp.json` | `mcpServers.grepmind` | `type: "stdio"`, `command`, `args`, `env` | Project config is `.cursor/mcp.json`; global config is `~/.cursor/mcp.json`. Cursor resolves variables in `command`, `args`, `env`, `url`, and `headers`. |
| OpenCode | `opencode.json` or JSONC variants | `mcp.grepmind` | `type: "local"`, `command`, `enabled`, `timeout`, `environment` | Phase 2. New files include `$schema: "https://opencode.ai/config.json"`. Local `command` is an array containing executable and args. |
| Gemini CLI | `.gemini/settings.json` | `mcpServers.grepmind` | `command`, `args`, `env`, `cwd`, `timeout` | Phase 2. `gemini mcp add` defaults to project scope. `timeout` is in milliseconds. Do not set `trust` by default. |

Generated configs intentionally target stdio/local MCP only. Do not generate remote HTTP/SSE/WebSocket entries for `grepmind init`.

## MCP Config Writers

Add a writer layer:

```text
packages/grepmind/src/init/
  agent-command.ts
  agents.ts
  args.ts
  command.ts
  detect.ts
  git.ts
  hostname.ts
  mcp-entry.ts
  project-config.ts
  writers/
    codex.ts
    claude.ts
    cursor.ts
    json-config.ts
    toml-config.ts
    gemini.ts     # phase 2
    opencode.ts   # phase 2
```

Shared writer contract:

```ts
interface InitAgentWriter {
  agent: InitAgentName;
  detect(workspaceRoot: string): Promise<boolean>;
  resolveConfigPath(workspaceRoot: string): string;
  readExistingEntry(path: string): Promise<unknown>;
  writeEntry(input: WriteMcpEntryInput): Promise<WriteResult>;
}
```

`writeEntry` must:

- create the parent directory;
- preserve unrelated config;
- replace only the `grepmind` MCP server entry;
- preserve an existing recognized Grepmind command if `--force` was not passed;
- update env, cwd, and timeout fields where supported;
- not touch other MCP servers.

Shared TOML replacement strategy:

- parse only enough TOML structure to identify section headers; do not reformat the whole file;
- a section header is a line whose trimmed content starts with `[name]` or `[[name]]` and contains only whitespace or a TOML comment after the closing bracket;
- the Grepmind block starts at `[mcp_servers.grepmind]`;
- the Grepmind block includes `[mcp_servers.grepmind]`, all following lines, and any nested sections whose names start with `mcp_servers.grepmind.`;
- the Grepmind block ends immediately before the next section header that is not `mcp_servers.grepmind` and does not start with `mcp_servers.grepmind.`;
- comments and blank lines inside the Grepmind block are treated as owned by the generated entry and may be replaced;
- comments, blank lines, section ordering, and raw bytes outside the Grepmind block must be preserved byte-for-byte;
- if `[mcp_servers.grepmind]` is absent, append the generated block to the end of the file with one separating blank line when the file is non-empty;
- if nested `[mcp_servers.grepmind.*]` sections exist before the root `[mcp_servers.grepmind]`, fail with a path-specific error instead of guessing block ownership;
- if duplicate `[mcp_servers.grepmind]` sections exist, fail with a path-specific error asking for manual cleanup.

Readiness criteria:

- Each writer returns a structured `WriteResult` describing `created`, `updated`, `unchanged`, or `would-change`.
- Shared JSON writer handles missing files, invalid JSON, and pretty-printing.
- Shared TOML writer preserves unrelated raw TOML sections and replaces only the owned Grepmind block.

## Codex Writer

Project config:

```text
.codex/config.toml
```

Section:

```toml
[mcp_servers.grepmind]
command = "npx"
args = ["-y", "@grepmind/mcp@0.1.1"]
cwd = "/abs/path/to/workspace"
startup_timeout_sec = 120
tool_timeout_sec = 60

[mcp_servers.grepmind.env]
GREPMIND_AGENT_HOSTNAME = "app.grepmind.ai"
GREPMIND_MCP_STARTUP_TIMEOUT_MS = "120000"
```

Current repository confirmation:

- `.codex/config.toml` already uses this section shape.
- The existing dev entry uses `command = "node"` and `packages/mcp/dist/index.js`; it must be recognized as a Grepmind local dev entry.

Replacement rule:

- If existing `mcp_servers.grepmind` is recognized and `--force` is not passed, preserve `command` and `args`.
- Always update `cwd`, `startup_timeout_sec`, `tool_timeout_sec`, and env values.
- If existing entry is unrecognized:
  - interactive mode asks before replacing;
  - `--yes` replaces only if `--codex` was explicit;
  - otherwise fail with a `--force` hint.

Codex TOML block rules:

- the generated Codex block is always emitted as `[mcp_servers.grepmind]` followed by `[mcp_servers.grepmind.env]`;
- when preserving a recognized local dev command, the writer keeps only the existing `command` and `args` values and regenerates the rest of the Grepmind block;
- existing comments inside `[mcp_servers.grepmind]` or `[mcp_servers.grepmind.*]` are not preserved, because they belong to the generated Grepmind entry;
- unrelated Codex settings, other MCP server sections, and comments outside the Grepmind block are preserved byte-for-byte;
- nested Grepmind sections other than `[mcp_servers.grepmind.env]` are removed on write unless they are part of a future known schema;
- if `[mcp_servers.grepmind.env]` exists without `[mcp_servers.grepmind]`, fail with a path-specific error instead of creating a split block.

Readiness criteria:

- Only `[mcp_servers.grepmind]` and nested `[mcp_servers.grepmind.*]` sections are replaced.
- Other TOML sections and comments outside the Grepmind block are preserved byte-for-byte.
- Comments inside the Grepmind block are allowed to be replaced.
- Generated `cwd` is the resolved Git root.
- Summary output mentions that Codex project config is used only when the project is trusted.

## Claude Writer

Project config:

```text
.mcp.json
```

Entry:

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

Readiness criteria:

- Preserve all non-`mcpServers.grepmind` keys.
- Create `mcpServers` if missing.
- Invalid JSON fails with path-specific guidance.
- Existing `.mcp.json` in this repository must preserve the local `node packages/mcp/dist/index.js` dev command unless `--force` is passed.
- Do not generate a `type` field for stdio Claude entries; the standard project `.mcp.json` shape uses `command`, `args`, and `env`.
- Summary output mentions that Claude Code may prompt for approval before first use of project-scoped `.mcp.json` servers.

## Cursor Writer

Project config:

```text
.cursor/mcp.json
```

Entry shape:

```json
{
  "mcpServers": {
    "grepmind": {
      "type": "stdio",
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

Readiness criteria:

- Same preservation behavior as Claude writer.
- Generated or replaced Cursor entries include `type: "stdio"`.
- If an existing recognized Grepmind Cursor entry omits `type`, preserve `command` and `args` but add or update `type` to `"stdio"`.
- Create `.cursor/` only when Cursor is selected for writing.
- Detection of `.cursor/` alone must not create `.cursor/mcp.json` unless selected.

## OpenCode Writer

Phase 2 only. The initial delivery must not write OpenCode config.

Initial delivery behavior:

- `--opencode` is rejected before side effects with a clear message that OpenCode support is planned for phase 2;
- OpenCode detection may be reported in dry-run output as detected but unsupported;
- `--all-detected` and `--yes` do not select OpenCode until this writer is implemented;
- `grepmind init --help` does not list `--opencode` until this writer is implemented.

Project config candidates, in order:

```text
opencode.json
opencode.jsonc
.opencode.json
.opencode.jsonc
```

Use the first existing file. If none exists and OpenCode is selected, create `opencode.json`.

Entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "grepmind": {
      "type": "local",
      "command": ["npx", "-y", "@grepmind/mcp@0.1.1"],
      "enabled": true,
      "timeout": 120000,
      "environment": {
        "GREPMIND_AGENT_HOSTNAME": "app.grepmind.ai",
        "GREPMIND_MCP_STARTUP_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

JSONC rule for the OpenCode phase 2 implementation:

- JSONC files are supported only with explicit `--opencode`.
- If the selected file is JSONC, interactive mode warns before writing because comments may be lost.
- In `--yes` mode, JSONC write is allowed only for explicit `--opencode`.

Phase 1 readiness:

- Phase 1 rejects `--opencode` before auth, runtime startup, registration, or file writes.

Phase 2 readiness:

- New OpenCode files include `$schema`.
- Generated OpenCode entries set `timeout` to the same value as `.grepmind.json.mcp.startupTimeoutMs`.
- OpenCode is not auto-created from detection unless selected by prompt, `--all-detected`, or `--opencode`.
- Preserve non-`mcp.grepmind` keys.
- Existing command array containing `@grepmind/mcp` or `grepmind-mcp` is recognized.

## Gemini Writer

Phase 2 only. The initial delivery must not write Gemini config.

Initial delivery behavior:

- `--gemini` is rejected before side effects with a clear message that Gemini support is planned for phase 2;
- Gemini detection may be reported in dry-run output as detected but unsupported;
- `--all-detected` and `--yes` do not select Gemini until this writer is implemented;
- `grepmind init --help` does not list `--gemini` until this writer is implemented.

Project config:

```text
.gemini/settings.json
```

Entry:

```json
{
  "mcpServers": {
    "grepmind": {
      "command": "npx",
      "args": ["-y", "@grepmind/mcp@0.1.1"],
      "cwd": "/abs/path/to/workspace",
      "timeout": 120000,
      "env": {
        "GREPMIND_AGENT_HOSTNAME": "app.grepmind.ai",
        "GREPMIND_MCP_STARTUP_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

Phase 1 readiness:

- Phase 1 rejects `--gemini` before auth, runtime startup, registration, or file writes.

Phase 2 readiness:

- Create `.gemini/` only when Gemini is selected for writing.
- Generated Gemini entries set `cwd` to the resolved Git root.
- Generated Gemini entries set `timeout` to the same value as `.grepmind.json.mcp.startupTimeoutMs`.
- Do not set `trust` by default.
- Preserve non-`mcpServers.grepmind` keys.
- Existing Grepmind command recognition follows the shared JSON writer rules.

## Existing Entry Recognition

An existing Grepmind MCP entry is recognized if any of these are true:

- command is `grepmind-mcp`;
- command is `npx` and args include a token that starts with `@grepmind/mcp`;
- command is `node` and args include a path ending in `packages/mcp/dist/index.js`;
- command array includes `@grepmind/mcp`, a token starting with `@grepmind/mcp`, or `grepmind-mcp`.

If recognized and `--force` is not set:

- preserve command and args;
- update/add env;
- update/add `cwd` when supported;
- update Codex startup and tool timeout fields.

If recognized and `--force` is set:

- replace command and args with the generated default or `--mcp-package` override;
- update env/cwd/timeout fields.

If not recognized:

- interactive mode asks before replacing;
- `--yes` replaces only when that client was explicitly selected;
- otherwise fail with a message explaining `--force`.

Readiness criteria:

- Recognition is implemented by structured config shape, not by raw substring replacement of the whole file.
- Local dev entries in this repository are preserved by default.

## File Write Safety

Rules:

- all writes are project-local under the resolved Git root;
- no `AGENTS.md` writes;
- no `.changeset` writes by hand;
- no secret writes into project files;
- create parent directories recursively only for selected writers;
- preserve file mode where possible;
- pretty-print JSON with 2 spaces;
- preserve unrelated TOML raw text outside replaced Grepmind sections.

Atomicity:

- Write files through a temporary sibling file and rename into place where practical.
- If a write fails, report the path and leave already-written earlier files as reported in the summary.

Readiness criteria:

- `--dry-run` prints exactly which files would be created or updated.
- Writer summaries identify `created`, `updated`, `unchanged`, or `skipped`.
- No writer scans or mutates outside the Git root.

## Public CLI Integration

Update `packages/grepmind/src/index.ts`:

```ts
case 'init':
  await runInitCommand(rest);
  return;
```

Update help output:

```text
grepmind init [--hostname <host>] [--codex|--claude|--cursor] [--yes]
```

Add or update public docs:

```text
packages/grepmind/README.md
packages/mcp/README.md
README.md
```

Readiness criteria:

- `grepmind help` lists `init`.
- `grepmind init --help` gives command-specific help.
- Unknown `grepmind init` flags fail before side effects.

## Package Dependencies

`packages/grepmind/package.json` needs a direct dependency on:

```json
{
  "@grepmind/agent-rpc": "0.1.1"
}
```

Rationale:

- `init` should call `ensureAgentReady` and `AgentRuntimeClient` directly;
- shelling out to `grepmind agent register` would require manual runtime orchestration and CLI output parsing;
- `@grepmind/agent-rpc` is already the package used by MCP for local runtime control.

MCP package version pinning:

- Do not add `@grepmind/mcp` as a runtime dependency just for version lookup.
- Use a build-time constant or generated local module for the compatible MCP package spec.

Readiness criteria:

- No new prompt dependency is added.
- Dependency changes are limited to packages required by the implementation.
- If package source changes require a changeset, generate it through `npm run changeset`; do not edit changeset files by hand.

## Implementation Phases

### Phase 1: Shared workspace registration helper

Move logic from `packages/mcp/src/runtime-context.ts` into `@grepmind/agent-rpc`:

- workspace fingerprint;
- remote URL resolution;
- repo full name parsing;
- default branch resolution;
- current branch resolution;
- unique local binding detection;
- idempotent registration.

Then update `@grepmind/mcp` to use the shared helper.

Phase 1 readiness:

- MCP behavior remains equivalent to current runtime-context behavior.
- `@grepmind/agent-rpc/src/index.ts` exports the helper and types.

### Phase 2: Init command skeleton

Create `packages/grepmind/src/init/command.ts`.

Responsibilities:

- parse args;
- reject unsupported global mode;
- resolve workspace root;
- load existing `.grepmind.json`;
- resolve hostname;
- detect/select agents;
- support `--dry-run`;
- print summary.

Phase 2 readiness:

- `grepmind init --dry-run --codex` works without auth/runtime side effects.
- All unknown/conflicting flags fail before side effects.

### Phase 3: OAuth/runtime/register flow

Add:

- bundled agent command resolver;
- auth status host mismatch handling;
- `ensureAgentReady(...)` call;
- `AgentRuntimeClient` registration through shared helper;
- clear errors for auth, account selection, runtime timeout, duplicate bindings, and missing Git remote.

Phase 3 readiness:

- `--yes --no-open` has no interactive/browser path.
- Missing auth in non-open mode fails clearly.

### Phase 4: Project config writer

Implement `.grepmind.json` reader/writer:

- schema v1;
- preserve unknown keys;
- normalize hostname;
- no secrets;
- no runtime registration state.

Phase 4 readiness:

- Existing unknown keys survive rerun.
- Same inputs are idempotent.

### Phase 5: MCP writers

Initial delivery scope:

1. Codex TOML writer.
2. Claude `.mcp.json` writer.
3. Cursor `.cursor/mcp.json` writer.

Phase 2 support:

4. OpenCode writer.
5. Gemini writer.

Phase 5 readiness:

- Initial PR can ship Codex + Claude + Cursor.
- Initial PR rejects OpenCode/Gemini flags before side effects and does not list those flags in `grepmind init --help`.
- OpenCode/Gemini are implemented in phase 2 with the criteria above.

### Phase 6: Docs and examples

Add examples:

```sh
grepmind init --codex
grepmind init --cursor --yes
grepmind init --all-detected
grepmind init --codex --dry-run
```

Document:

- generated files;
- no-secret guarantee;
- `--yes` vs `--yes --no-open`;
- client-specific caveats: Codex project config requires a trusted project; Claude Code may ask to approve project-scoped `.mcp.json`; OpenCode/Gemini are phase 2;
- how to update the pinned MCP package.

Phase 6 readiness:

- Docs match generated config shape.
- Docs do not mention API keys.

## Verification Plan

Per project instruction, do not run `test` or `tsc` manually for verification.

Use build when code changes require verification:

```sh
npm run build
```

Manual checks for the implementation PR:

1. `grepmind init --codex --dry-run`
2. verify no files changed after dry-run
3. `grepmind init --codex --yes --no-open` with missing auth must fail clearly
4. `grepmind init --codex --yes`
5. inspect `.grepmind.json`
6. inspect `.codex/config.toml`
7. rerun `grepmind init --codex --yes` and verify idempotent output
8. run the configured MCP command from the project root when needed
9. verify `grepmind_agent_status` returns the expected workspace and binding when MCP is started

Do not edit `.changeset/*.md` by hand. If package source changes require a changeset, generate it through:

```sh
npm run changeset
```

Readiness criteria:

- Build passes when implementation changes code.
- Dry-run verification proves no side effects.
- Manual MCP check proves generated config starts Grepmind MCP for the resolved Git root.

## Resolved Product Decisions

Initial delivery supports:

- Codex;
- Claude;
- Cursor.

Phase 2 supports:

- OpenCode;
- Gemini.

Resolved defaults:

- `.grepmind.json` is commit-safe.
- Default MCP package is pinned to the current compatible `@grepmind/mcp` version.
- `grepmind init` registers workspace eagerly, except in `--dry-run`.
- Existing recognized local dev Grepmind MCP entries are preserved unless `--force` is passed.
- `grepmind init` can run from any directory inside a Git workspace and writes to the resolved Git root.

The plan is ready for implementation when all readiness criteria above are accepted.

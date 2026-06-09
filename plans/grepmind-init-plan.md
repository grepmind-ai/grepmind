# Plan: `grepmind init` for project-local MCP setup

## Goal

Add a public command:

```sh
grepmind init
```

The command should be the Grepmind MCP equivalent of `ctx7 setup`, adapted to the current Grepmind MCP architecture:

- project scope only;
- OAuth through the existing Grepmind agent login flow;
- project-local Grepmind config without secrets;
- project-local MCP config for the selected AI agent;
- interactive mode when required inputs are missing;
- non-interactive behavior through flags;
- idempotent reruns without destroying unrelated MCP server entries.

`grepmind init` should be the main onboarding flow for local search:

1. choose the Grepmind backend hostname;
2. log in through OAuth and select an account;
3. start or reuse the local agent runtime;
4. register the current Git workspace;
5. write the project config;
6. write the `grepmind` MCP server entry into the selected agent config.

## Non-goals

- Do not support global setup.
- Do not bring back API key setup. Grepmind agent auth has moved to OAuth.
- Do not edit `AGENTS.md`, rules, or skills.
- Do not add hosted HTTP MCP. The current `@grepmind/mcp` runs over stdio.
- Do not support multiple workspaces in one MCP server instance.
- Do not store OAuth tokens, account session tokens, or other secrets in the project.

## Current state

The public CLI:

```text
packages/grepmind/src/index.ts
```

currently proxies:

- `grepmind auth ...` to `@grepmind/agent`;
- `grepmind agent ...` to `@grepmind/agent`;
- `grepmind deploy ...` to the local deploy command.

There is no separate `grepmind init` command.

OAuth and account selection are already implemented here:

```text
packages/agent/src/cli/command-handlers/auth.ts
```

Agent bootstrap primitives are already exported from `@grepmind/agent-rpc`:

```text
packages/agent-rpc/src/bootstrap.ts
```

Key functions:

- `getAgentAuthStatus(...)`
- `ensureAgentAuth(...)`
- `ensureAgentRuntime(...)`
- `ensureAgentReady(...)`
- `resolveAgentDataDir(...)`
- `AgentRuntimeClient`

MCP startup already knows how to:

- resolve the Git workspace root;
- find the bundled `@grepmind/agent`;
- ensure auth/runtime readiness;
- auto-register the workspace;
- obtain the runtime project record for the selected workspace.

Key file:

```text
packages/mcp/src/runtime-context.ts
```

`grepmind init` should reuse the same model, but make setup explicit before the MCP client starts.

## Command UX

### Basic interactive run

```sh
grepmind init
```

Behavior:

1. Check that cwd is inside a Git workspace.
2. Resolve the Git root.
3. Find agent configs in the project.
4. Choose hostname: use `--hostname` if provided, otherwise `app.grepmind.ai`.
5. If no agent was selected by flag and multiple options were found, show a selection prompt.
6. If the user is not logged in for the selected data dir, start OAuth login.
7. Start the agent runtime.
8. Register the workspace or reuse an existing local binding.
9. Write `.grepmind.json`.
10. Write the MCP config for the selected agent.
11. Print a summary and next steps.

### Non-interactive run

```sh
grepmind init --codex --yes
```

`--yes` disables terminal prompts and confirmations, but does not by itself forbid the OAuth browser flow. If the user is not logged in or has not selected an account, the command may open a browser unless `--no-open` is provided.

Fully non-interactive mode is expressed by this combination:

```sh
grepmind init --codex --yes --no-open
```

In fully non-interactive mode, the command must not ask questions, open a browser, or wait for account selection. If required data/auth/account state is missing, it fails with a clear error.

### Recommended flags

```text
--hostname <host>                 Grepmind backend hostname, default app.grepmind.ai, without scheme/path
--codex                           configure Codex project config
--claude                          configure Claude project config
--cursor                          configure Cursor project config
--opencode                        configure OpenCode project config
--gemini                          configure Gemini CLI project config
--all-detected                    configure all autodetected agents
-y, --yes                         do not ask terminal confirmation/prompt questions
--no-open                         do not automatically open the browser during OAuth
--data-dir <dir>                  Grepmind agent data dir
--agent-name <name>               local agent display name for OAuth config
--mcp-package <pkg>               override MCP package spec, default @grepmind/mcp@<current>
--mcp-startup-timeout-ms <ms>     env GREPMIND_MCP_STARTUP_TIMEOUT_MS for the MCP entry
--force                           overwrite existing grepmind MCP entry without confirmation
--dry-run                         show planned writes without writing files
```

Flags `--project` and `--global` are not needed. If they are added for compatibility with user expectations:

- `--project` should be a no-op;
- `--global` should fail with `grepmind init only supports project scope`.

## Project config

There is exactly one supported Grepmind project config file in the Git root:

```text
.grepmind.json
```

`grepmind init` must not search for, read, or write alternative Grepmind project config files. This is the only canonical project config path.

Reason: the config is small, non-secret, easy to inspect, and does not require a separate directory. If cache/artifacts/policies are needed later, `.grepmind/` can be added without migrating this file.

The file must not contain:

- OAuth access token;
- refresh token;
- account session token;
- absolute workspace path by default;
- machine-specific secure storage key.

Proposed schema v1:

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

Notes:

- `hostname` is stored without `https://` and without a path.
- `mcp.package` should default to the pinned current compatible `@grepmind/mcp` version.
- `startupTimeoutMs` is needed because first MCP startup may include auth/runtime/register work.
- `.grepmind.json` contains only project-level Grepmind settings and does not store runtime registration state.

Rerun behavior:

- if `.grepmind.json` exists, preserve unknown keys;
- update only known keys: `version`, `hostname`, `mcp`;
- if hostname changes, ask for confirmation in interactive mode;
- resolve hostname strictly in this order: `--hostname`, then existing `.grepmind.json.hostname`, then `app.grepmind.ai`;
- in `--yes` mode, use the resolved hostname without prompting, but do not reset existing `.grepmind.json.hostname` to the default.

## Agent detection

`grepmind init` works only from the Git root of the project. Detection checks project-local files/directories.

Suggested signals:

| Agent | Detection |
| --- | --- |
| Codex | `.codex/` or `.codex/config.toml` |
| Claude | `.mcp.json` or `.claude/` |
| Cursor | `.cursor/` or `.cursor/mcp.json` |
| OpenCode | `opencode.json`, `opencode.jsonc`, `.opencode.json`, `.opencode.jsonc` |
| Gemini CLI | `.gemini/` or `.gemini/settings.json` |

Algorithm:

1. If an agent flag is provided, use only explicitly selected agents.
2. If `--all-detected` is provided, use all detected agents.
3. If exactly one agent is detected and `--yes` is set, use it.
4. If multiple agents are detected and TTY is available, show a checkbox/list prompt.
5. If nothing is detected and TTY is available, show the full list of supported agents.
6. If nothing is detected and TTY is not available, fail and ask for an agent flag.

Use `node:readline/promises` for prompts, as in `packages/grepmind/src/deploy.ts`, without adding new prompt dependencies.

## OAuth and agent readiness

`grepmind init` must reuse the existing OAuth flow instead of implementing a second one.

Planned path:

1. Add a dependency from `grepmind` to `@grepmind/agent-rpc`.
2. Add a helper that resolves the bundled `@grepmind/agent` entrypoint from the `@grepmind/agent` dependency, analogous to `resolveBundledAgentCommand()` in `packages/mcp/src/runtime-context.ts`.
3. Call:

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
- browser account selection;
- secure credential storage;
- non-secret `~/.grepmind-agent/agent-config.json`;
- started/reused local runtime.

`hostname` should be resolved from:

1. `--hostname`;
2. existing `.grepmind.json.hostname`;
3. default `app.grepmind.ai`.

Only canonical `.grepmind.json` may affect project hostname resolution. Existing agent config auth host must not affect the default hostname. If a self-hosted backend is needed for a new project without `.grepmind.json`, the user must explicitly pass `--hostname <host>`.

Only hostname is written to project `.grepmind.json`, not tokens.

`--yes` does not forbid OAuth login/account selection browser flow. If `--no-open` is provided and auth/account selection is required, `grepmind init` must fail with a clear error instead of waiting for interactive action.

## Workspace registration

Registration logic is currently partially duplicated between the agent CLI and MCP startup. For `init`, it is better to extract a shared helper into `@grepmind/agent-rpc` so that `@grepmind/mcp` and `grepmind init` use the same algorithm.

Proposed new export:

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

1. Compute `workspaceFingerprint` using `realpath`, `stat.dev`, `stat.ino`, `sha256`.
2. Call `client.listProjects()`.
3. Find existing records by:
   - exact normalized `workspacePath`;
   - matching `realpath`;
   - matching `workspaceFingerprint`.
4. If exactly one binding is found, return it.
5. If multiple bindings are found, throw an error asking the user to clean/unbind manually.
6. If no binding is found:
   - read `git remote get-url origin`;
   - derive `repoFullName` from remote URL when possible;
   - read default branch;
   - read current branch;
   - call `client.registerProject(...)`.
7. Use a deterministic idempotency key:

```text
init-register:<sha256(workspaceFingerprint + "\0" + remoteUrl)>
```

After this, `grepmind init` must not write runtime registration state to `.grepmind.json`.

## MCP launch command

Default command for project MCP config:

```json
{
  "command": "npx",
  "args": ["-y", "@grepmind/mcp@0.1.1"]
}
```

Why not `grepmind-mcp`:

- the user may run `npx grepmind init` without a global install;
- the MCP client starts later and does not have to see the same npm binary;
- `npx -y @grepmind/mcp@<version>` pulls the package with a bundled compatible `@grepmind/agent`.

Why pin the version:

- project config becomes reproducible;
- `@grepmind/mcp` carries a compatible `@grepmind/agent`;
- MCP version can be updated by rerunning `grepmind init --force` or by a future `grepmind update`.

The `--mcp-package` flag is needed for dev/nightly scenarios:

```sh
grepmind init --codex --mcp-package @grepmind/mcp@latest
grepmind init --codex --mcp-package file:../mcp
```

## MCP env

The MCP entry must pass:

```text
GREPMIND_AGENT_HOSTNAME=<hostname>
GREPMIND_MCP_STARTUP_TIMEOUT_MS=<timeout>
```

Optionally, only if the user passed `--data-dir`:

```text
GREPMIND_AGENT_DATA_DIR=<dataDir>
```

`GREPMIND_AGENT_DATA_DIR` should not be written by default, to avoid pinning a machine-specific absolute path in project config.

## MCP config writers

Add a writer layer in `packages/grepmind/src/init/`.

Suggested structure:

```text
packages/grepmind/src/init/
  agents.ts
  command.ts
  detect.ts
  mcp-entry.ts
  project-config.ts
  writers/
    codex.ts
    json-config.ts
    toml-config.ts
```

### Shared writer contract

```ts
interface InitAgentWriter {
  agent: InitAgentName;
  detect(workspaceRoot: string): Promise<boolean>;
  resolveConfigPath(workspaceRoot: string): string;
  readExistingEntry(path: string): Promise<unknown>;
  writeEntry(input: WriteMcpEntryInput): Promise<WriteResult>;
}
```

`writeEntry` should:

- create the parent directory;
- preserve unrelated config;
- replace only the `grepmind` server entry;
- preserve an existing Grepmind command if it already points to Grepmind MCP and `--force` was not passed;
- update env, cwd, and timeout;
- not touch other MCP servers.

### Codex writer

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

Notes:

- the current Codex project config in this repo already uses `cwd`, `startup_timeout_sec`, and `tool_timeout_sec`;
- the writer should preserve an existing Grepmind local dev entry if command is already `node` and args point to `packages/mcp/dist/index.js`;
- if the existing entry is not Grepmind or `--force` is set, replace only `[mcp_servers.grepmind]` and nested `[mcp_servers.grepmind.*]` sections as a whole.

### Claude writer

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

If the Claude config format in the project requires other fields, the writer must be adjusted before implementation. Basic Claude support is limited to `.mcp.json`.

### Cursor writer

Project config:

```text
.cursor/mcp.json
```

Entry shape is the same as `.mcp.json`:

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

### OpenCode writer

Project config candidates:

```text
opencode.json
opencode.jsonc
.opencode.json
.opencode.jsonc
```

Use the first existing file, otherwise create `opencode.json`.

Entry:

```json
{
  "mcp": {
    "grepmind": {
      "type": "local",
      "command": ["npx", "-y", "@grepmind/mcp@0.1.1"],
      "enabled": true,
      "environment": {
        "GREPMIND_AGENT_HOSTNAME": "app.grepmind.ai",
        "GREPMIND_MCP_STARTUP_TIMEOUT_MS": "120000"
      }
    }
  }
}
```

Field names must be verified against OpenCode docs before implementation. If uncertain, ship OpenCode support behind explicit `--opencode` only and document the expected config shape.

### Gemini writer

Project config:

```text
.gemini/settings.json
```

Expected section:

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

Gemini support can be phase 2 if initial delivery scope should stay narrower.

## Existing entry preservation

The Grepmind writer should recognize an existing Grepmind MCP entry if any of these are true:

- command is `grepmind-mcp`;
- command is `npx` and args include `@grepmind/mcp`;
- command is `node` and args include a path ending in `packages/mcp/dist/index.js`;
- command array includes `@grepmind/mcp` or `grepmind-mcp`.

If the existing entry is recognized and `--force` is not set:

- preserve command/args;
- update/add env;
- update/add cwd when supported;
- update Codex startup timeout fields.

If the existing entry is not recognized:

- interactive mode asks before replacing;
- `--yes` replaces only when the agent was explicitly selected;
- otherwise fail with a message explaining `--force`.

## File write safety

Rules:

- all writes are project-local;
- no `AGENTS.md` writes;
- no `.changeset` writes;
- no secret writes into project files;
- create parent dirs recursively;
- preserve file mode where possible;
- pretty-print JSON with 2 spaces;
- for JSONC configs, strip comments for parsing but warn that comments may be lost unless a JSONC-preserving writer is added.

For TOML:

- implement minimal section replacement for `[mcp_servers.grepmind]`;
- preserve all unrelated sections as raw text;
- replace nested `[mcp_servers.grepmind.*]` subsections with the Grepmind block.

## Public CLI integration

Update:

```text
packages/grepmind/src/index.ts
```

Add:

```ts
case 'init':
  await runInitCommand(rest);
  return;
```

Update help output:

```text
grepmind init [--hostname <host>] [--codex|--claude|--cursor|--opencode|--gemini] [--yes]
```

Add public docs:

```text
packages/grepmind/README.md
packages/mcp/README.md
README.md
```

## Package dependencies

`grepmind` needs a direct dependency on:

```json
{
  "@grepmind/agent-rpc": "0.1.1"
}
```

Rationale:

- `init` should call `ensureAgentReady` and `AgentRuntimeClient` directly;
- shelling out to `grepmind agent register` would require manual runtime orchestration and CLI output parsing;
- `@grepmind/agent-rpc` is the stable package for local runtime control.

For MCP package version pinning, choose one:

1. Add a direct dependency on `@grepmind/mcp` and read its package version at runtime.
2. Generate a build-time constant from workspace package versions.
3. Use unpinned `@grepmind/mcp` initially and add pinning later.

Recommended: option 1 if package size is acceptable; otherwise option 2.

## Implementation phases

### Phase 1: Shared workspace registration helper

Move or duplicate carefully from `packages/mcp/src/runtime-context.ts` into `@grepmind/agent-rpc`:

- workspace fingerprint;
- remote URL resolution;
- repo full name parsing;
- default branch resolution;
- current branch resolution;
- unique local binding detection;
- idempotent registration.

Update `@grepmind/mcp` to use the shared helper.

### Phase 2: Init command skeleton

Create:

```text
packages/grepmind/src/init/command.ts
```

Responsibilities:

- parse args;
- reject unsupported global mode;
- resolve workspace root;
- load existing `.grepmind.json`;
- resolve hostname;
- detect/select agents;
- support `--dry-run`;
- print summary.

### Phase 3: OAuth/runtime/register flow

Add:

- bundled agent command resolver in `packages/grepmind/src/init/agent-command.ts`;
- `ensureAgentReady(...)` call;
- `AgentRuntimeClient` registration via shared helper;
- clear error messages for auth, account selection, runtime timeout, and missing Git remote.

### Phase 4: Project config writer

Implement `.grepmind.json` reader/writer:

- schema v1;
- preserve unknown keys;
- normalize hostname;
- no secrets;
- no runtime registration state.

### Phase 5: MCP writers

Implement writers in this order:

1. Codex TOML writer.
2. Claude `.mcp.json` writer.
3. Cursor `.cursor/mcp.json` writer.
4. OpenCode writer after config shape verification.
5. Gemini writer after config shape verification.

Initial delivery can ship Codex + Claude + Cursor first if scope needs to stay small.

### Phase 6: Docs and examples

Add examples:

```sh
grepmind init --codex
grepmind init --cursor --yes
grepmind init --all-detected
```

Document generated files and the no-secret guarantee.

## Verification plan

Per project instruction, do not run `test` or `tsc` manually for verification.

Use build when code changes require verification:

```sh
npm run build
```

Manual checks for the implementation PR:

1. `grepmind init --codex --dry-run`
2. `grepmind init --codex --yes`
3. inspect `.grepmind.json`
4. inspect `.codex/config.toml`
5. run the configured MCP client or launch the generated command from the project root
6. verify `grepmind_agent_status` returns the expected workspace and binding

Do not edit `.changeset/*.md` by hand. If package source changes require a changeset, generate it through:

```sh
npm run changeset
```

## Open questions

1. Should initial delivery support only Codex first, or Codex + Claude + Cursor?
2. Should `.grepmind.json` be intended for commit, or should it be treated as local project setup?
3. Should default MCP package be pinned exactly or use `@grepmind/mcp@latest`?
4. Should `grepmind init` register workspace eagerly, or only configure MCP and let MCP startup auto-register?
5. Should existing local dev MCP entries, like `node packages/mcp/dist/index.js`, always be preserved?

Recommended defaults:

- Support Codex + Claude + Cursor in initial delivery.
- Treat `.grepmind.json` as commit-safe because it has no secrets and no absolute paths by default.
- Pin `@grepmind/mcp` to the current compatible version.
- Register workspace eagerly during `init`.
- Preserve recognized local dev Grepmind MCP entries unless `--force` is passed.

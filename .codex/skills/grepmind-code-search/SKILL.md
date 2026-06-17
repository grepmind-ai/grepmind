---
name: grepmind-code-search
description: Use for any request in a project-local repository workspace where code or docs context may help, including implementation, architecture, data flow, API, UI, test, deployment, documentation, debugging, review, or behavior questions. Always call the project-local MCP semantic code search tool before relying on rg, grep, find, or manual file browsing. Also use when the user mentions code_search, semantic search, or asks to find where behavior is implemented.
---

# Project Code Search

## Required Workflow

1. If `mcp__grepmind.code_search` is available in the session, call it directly. It is configured for the current project-local workspace. Do not run a preflight status check; the tool returns a clear error when the agent, index, auth, or workspace is not ready.
2. If `mcp__grepmind.code_search` is not visible in the session tools, call `tool_search` with query `grepmind code_search semantic code search`.
3. Start discovery with `mcp__grepmind.code_search` before `rg`, `grep`, `find`, or broad manual file reads.
4. Use `rg`, `sed`, `git`, or direct file reads only after semantic search identifies likely files, symbols, or paths.
5. Treat search results as leads, not source of truth. Read the actual files before editing or giving a final answer.
6. If search fails with a readiness error, report the error text and follow any concrete remediation it gives. If results look stale, empty, or unrelated, refine the query first.

## Search Strategy

Use natural-language queries that describe behavior. Prefer several focused searches over one vague query.

Good query shapes:

```text
where incoming webhook errors are handled
```

```text
how sync status is calculated and displayed
```

```text
UI flow for connecting an external source
```

```text
deployment command generation
```

Use `target: "code"` for implementation and `target: "docs"` for markdown or documentation. Use `path` when the area is known, for example `apps`, `packages`, `src`, `docs`, or `e2e`.

Start broad with `compact: true` when orienting, then rerun with `compact: false` for the most relevant area. Lower `threshold` only when the first query returns too few useful results.

## Tool Examples

Broad implementation search:

```json
{
  "query": "describe the behavior to find",
  "target": "code",
  "limit": 10,
  "compact": true
}
```

Focused implementation search:

```json
{
  "query": "how auth redirects are handled",
  "path": "apps/app",
  "target": "code",
  "limit": 10,
  "compact": false
}
```

Documentation search:

```json
{
  "query": "self-hosted deployment configuration",
  "target": "docs",
  "limit": 10
}
```

## Repository Boundaries

- `mcp__grepmind.code_search` searches the project-local workspace configured for the current session.
- Do not assume it searches a different repository unless the session configuration points there.
- If a task spans multiple repositories, search and verify in the repository that owns the requested behavior, then cross-check the other repository only when needed.

## Verification

After semantic search returns candidates, read the source files and confirm exact names, paths, and behavior. Use exact text search with `rg` for call sites, error strings, routes, symbols, and tests once the semantic search has narrowed the area.

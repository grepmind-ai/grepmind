# @grepmind/agent

## 0.3.2

### Patch Changes

- 91fc03e: Revert path-scoped search filtering and restore the previous MCP search behavior.

## 0.3.1

### Patch Changes

- f8c6c0c: Add path-scoped search filtering and make MCP require an already running agent runtime.

## 0.3.0

### Minor Changes

- c6681f3: Replace the MCP context_layer tool with expanded code_search exact matching, including multiple patterns and scoped paths.

### Patch Changes

- Updated dependencies [c6681f3]
  - @grepmind/agent-rpc@0.4.0

## 0.2.0

### Minor Changes

- ee2a8d2: Add exact local rg search to code_search and introduce Codex-powered context_layer context packs

### Patch Changes

- Updated dependencies [ee2a8d2]
  - @grepmind/agent-rpc@0.3.0

## 0.1.12

### Patch Changes

- Updated dependencies [874f02a]
  - @grepmind/agent-rpc@0.2.4

## 0.1.11

### Patch Changes

- 1ebed20: Stop macOS launchd runtime supervisors during agent stop

## 0.1.10

### Patch Changes

- 9b4492a: Queue local head repair before serving search results.

## 0.1.9

### Patch Changes

- cdd7fcd: Allow agent snapshot exports for newly observed branches before the local branch projection has received the server repo branch id.

## 0.1.8

### Patch Changes

- 8cf4b90: Refactor agent realtime source helpers to satisfy lint limits.

## 0.1.7

### Patch Changes

- Updated dependencies [2f5cb74]
  - @grepmind/agent-rpc@0.2.3

## 0.1.6

### Patch Changes

- e81f9a1: Clean up auth callback timeout handles after login.

## 0.1.5

### Patch Changes

- fe82c5b: Harden MCP runtime startup and expose agent stop command
- Updated dependencies [fe82c5b]
  - @grepmind/agent-rpc@0.2.2

## 0.1.4

### Patch Changes

- Patch refresh packages
- Updated dependencies
  - @grepmind/agent-rpc@0.2.1

## 0.1.3

### Patch Changes

- Updated dependencies [28bf574]
  - @grepmind/agent-rpc@0.2.0

## 1.0.0

### Major Changes

- 7ed7448: Adopt OAuth-only agent authentication with PKCE login, secure credential storage, token refresh, and realtime reconnects.

### Minor Changes

- ee15072: add agent oauth flow

## 0.1.1

### Patch Changes

- 1951d3b: Testing
- Updated dependencies [1951d3b]
  - @grepmind/agent-rpc@0.1.1

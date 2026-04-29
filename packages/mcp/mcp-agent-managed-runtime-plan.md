# План: MCP сервер управляет локальным агентом

## Цель

Сделать `@grepmind/mcp` project-local MCP сервером: один MCP server instance обслуживает один Git workspace.

MCP должен считаться подключённым только после того, как:

- workspace root определён из project-local `mcp.json`
- пользователь авторизован в Grepmind agent
- agent runtime запущен
- workspace зарегистрирован в agent runtime

После успешного startup tool calls не должны запускать OAuth, выбирать репозиторий или регистрировать workspace. Они только используют уже подготовленный server-side context.

## Основной контракт

Grepmind MCP не поддерживает глобальную настройку без workspace. Для поиска требуется project-local MCP config.

Рекомендуемая настройка:

```json
{
  "mcpServers": {
    "grepmind": {
      "command": "grepmind-mcp",
      "args": ["--workspace", "${workspaceFolder}"]
    }
  }
}
```

Если MCP client не поддерживает `${workspaceFolder}`, он должен запускать project-local config с `cwd` равным root проекта. В этом случае MCP может использовать `process.cwd()`, но только после проверки, что это Git workspace.

Один workspace = один MCP server process. Multi-root в одном Grepmind MCP instance не поддерживается. Для нескольких репозиториев нужно несколько project-local configs или несколько server instances, каждый со своим `--workspace`.

## Текущее состояние

Сейчас MCP инструмент `code_search` вызывает:

- `packages/mcp/src/tools/code_search.ts`
- `packages/mcp/src/tools/search-client.ts`
- `AgentRuntimeClient.searchHead(...)` из `@grepmind/agent-rpc`

Если agent runtime не запущен, `search-client.ts` возвращает ошибку с инструкцией вручную запустить агент.

В `@grepmind/agent-rpc` уже есть нужные primitives:

- `ensureAgentReady(...)` - auth + runtime
- `ensureAgentRuntime(...)` - runtime only
- `startAgentRuntime(...)`
- `waitForAgentRuntimeReady(...)`
- `AgentRuntimeClient`

Ключевой файл:

```text
packages/agent-rpc/src/bootstrap.ts
```

## Startup Flow

Порядок startup должен быть таким:

1. Создать `McpServer`.
2. Зарегистрировать tools.
3. Определить workspace root.
4. Вызвать `ensureAgentReady(...)`.
5. Проверить/зарегистрировать workspace в agent runtime.
6. Сохранить `workspacePath` в server-side context.
7. Подключить `StdioServerTransport`.

MCP client увидит connected только после шага 7.

## Workspace Resolution

Добавить CLI argument:

```text
--workspace <path>
```

Resolver:

1. Если передан `--workspace`, использовать его.
2. Иначе использовать `process.cwd()`.
3. Нормализовать путь через `path.resolve`.
4. Найти Git top-level:

```bash
git -C <path> rev-parse --show-toplevel
```

5. Если Git root не найден, завершить startup с ошибкой.
6. Сохранить Git root как `workspaceContext.workspacePath`.

Не использовать MCP roots, env fallback или путь установки MCP как основной механизм. В этой модели source of truth - project-local MCP config.

## Agent Readiness

Добавить helper:

```text
packages/mcp/src/tools/agent-runtime.ts
```

Пример API:

```ts
export interface McpWorkspaceContext {
  workspacePath: string;
}

export async function prepareMcpRuntime(options: {
  workspacePath: string;
}): Promise<McpWorkspaceContext>;

export function getReadyAgentRuntimeClient(): AgentRuntimeClient;
```

Логика `prepareMcpRuntime`:

1. Resolve `dataDir` из `GREPMIND_AGENT_DATA_DIR` или default `~/.grepmind-agent`.
2. Вызвать:

```ts
await ensureAgentReady({
  dataDir,
  hostname: process.env.GREPMIND_AGENT_HOSTNAME,
  noOpen: false,
});
```

3. Если пользователь не залогинен и `GREPMIND_AGENT_HOSTNAME` не задан, завершить startup с ошибкой.
4. Если нужен login, открыть browser OAuth flow во время startup.
5. После готовности runtime создать/закэшировать `AgentRuntimeClient`.

`noOpen` должен быть `false`: если login нужен, MCP startup должен открыть браузер.

## Workspace Registration

После readiness MCP должен гарантировать, что startup workspace зарегистрирован.

Алгоритм:

1. Вызвать `client.listProjects()`.
2. Проверить, есть ли project с `workspacePath === workspaceContext.workspacePath`.
3. Если есть, продолжить startup.
4. Если нет, собрать metadata из Git workspace:
   - `remoteUrl` из `git remote`
   - `displayName` из basename root
   - `repoFullName` из remote URL, если распознаётся
   - `defaultBranch` из Git refs/config, если доступно
   - `workspaceFingerprint`
5. Вызвать `client.registerProject(...)`.
6. Опционально сразу вызвать `client.syncProject(...)`.

Регистрация происходит только на startup и только для workspace root из project-local config. `code_search` не регистрирует workspace.

Если metadata для регистрации недостаточно, startup должен завершиться понятной ошибкой с командой ручной регистрации.

## Tool API

`code_search` не должен принимать `workspacePath`.

Schema:

```ts
{
  query: string;
  target?: 'code' | 'docs';
  limit?: number;
  threshold?: number;
  path?: string;
  tags?: string[];
  compact?: boolean;
}
```

Handler всегда подставляет server-side workspace:

```ts
await client.searchHead({
  workspacePath: workspaceContext.workspacePath,
  query: input.query,
  target: input.target ?? 'code',
  limit,
  threshold,
  rerank: true,
  tags,
});
```

LLM не видит путь и не выбирает репозиторий. Agent RPC всё равно получает явный `workspacePath`.

## Diagnostics Tools

Добавить tool:

```text
grepmind_agent_status
```

Он должен возвращать:

- `workspacePath`
- `dataDir`
- auth status
- runtime status
- registered project для текущего workspace
- last sync status

## Errors

Startup errors:

- workspace не передан и `process.cwd()` не является Git workspace
- агент не авторизован и `GREPMIND_AGENT_HOSTNAME` не задан
- OAuth login не завершился
- agent runtime не удалось запустить
- workspace не удалось зарегистрировать

Tool errors после успешного startup:

- agent runtime умер после подключения MCP
- search index для текущего workspace ещё не готов
- sync завершился ошибкой

`code_search` не должен возвращать ошибку "выберите workspace" или "зарегистрируйте workspace", если startup прошёл успешно.

## Env Configuration

Поддержать:

```text
GREPMIND_AGENT_DATA_DIR
GREPMIND_AGENT_HOSTNAME
```

`GREPMIND_WORKSPACE_PATH` не нужен. Workspace должен приходить из project-local MCP config через `--workspace` или project-local `cwd`.

## Риски

### Не установлен `grepmind-agent`

`ensureAgentReady(...)` по умолчанию запускает `grepmind-agent`. Если бинарь недоступен в `PATH`, MCP startup должен завершиться понятной ошибкой.

### OAuth при startup

MCP startup может открыть браузер и ждать login. Это ожидаемое поведение: MCP считается connected только когда агент работает и залогинен.

### Project-local cwd зависит от клиента

Некоторые MCP clients могут запускать server не из root проекта даже при project-local config. Поэтому preferred path - явный `--workspace`.

### Multi-root

Один Grepmind MCP instance не поддерживает несколько roots. Это сознательное ограничение, чтобы LLM не выбирал репозиторий и чтобы agent RPC всегда получал один явный `workspacePath`.

## Рекомендуемый порядок реализации

1. Добавить parsing `--workspace <path>`.
2. Добавить workspace resolver: `--workspace`, иначе `process.cwd()`, затем Git top-level.
3. Добавить `packages/mcp/src/tools/agent-runtime.ts`.
4. Вызвать startup preparation в `packages/mcp/src/index.ts` до `server.connect(transport)`.
5. Добавить авто-регистрацию startup workspace.
6. Убрать `workspacePath` из `code_search` schema.
7. Передавать `workspaceContext.workspacePath` в `searchHead(...)`.
8. Обновить ошибки.
9. Добавить `grepmind_agent_status`.
10. Запустить build для проверки новой версии кода.

## Минимальный MVP

Для первого изменения достаточно:

- `--workspace <path>`
- resolve Git root
- `ensureAgentReady(...)` на startup
- регистрация workspace на startup
- `code_search` без `workspacePath`
- server-side подстановка `workspaceContext.workspacePath`
- подключение `StdioServerTransport` только после готовности

Это даёт строгую модель: MCP сам поднимает и логинит агента, workspace фиксируется на startup, а поиск всегда идёт по одному явно определённому репозиторию без участия LLM.

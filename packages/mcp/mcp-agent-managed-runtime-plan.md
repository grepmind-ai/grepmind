# План: MCP сервер управляет локальным агентом

## Цель

Сделать `@grepmind/mcp` project-local MCP сервером: один MCP server instance обслуживает один Git workspace.

MCP должен считаться подключённым только после того, как:

- workspace root определён из project-local `mcp.json`
- пользователь авторизован в Grepmind agent
- agent runtime запущен
- workspace зарегистрирован в agent runtime
- workspace сопоставлен с ровно одним local project binding (`bindingId`)

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

Server-side context должен содержать не только путь, но и resolved project binding. Tool calls не выбирают repository и не ищут binding повторно: они используют `bindingId` и `workspacePath`, подготовленные на startup.

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
5. Проверить/зарегистрировать workspace в agent runtime и получить ровно один project binding.
6. Сохранить `workspacePath`, `bindingId`, `dataDir`, `AgentRuntimeClient` и registered project в server-side context.
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
import type {
  AgentRuntimeClient,
  LocalProjectRecord,
} from '@grepmind/agent-rpc';

export interface McpWorkspaceContext {
  workspacePath: string;
  bindingId: number;
  dataDir: string;
  project: LocalProjectRecord;
}

export async function prepareMcpRuntime(options: {
  workspacePath: string;
}): Promise<McpWorkspaceContext>;

export function getMcpWorkspaceContext(): McpWorkspaceContext;
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
6. Вызвать workspace registration helper, получить `bindingId` и project.
7. Вернуть и закэшировать полный `McpWorkspaceContext`.

`noOpen` должен быть `false`: если login нужен, MCP startup должен открыть браузер.

Использовать `resolveAgentDataDir(...)` из `@grepmind/agent-rpc`, чтобы default и relative path semantics совпадали с agent bootstrap.

## Workspace Registration

После readiness MCP должен гарантировать, что startup workspace зарегистрирован.

Алгоритм:

1. Вычислить startup `workspaceFingerprint` через `realpath`, `stat.dev`, `stat.ino`, `sha256`.
2. Вызвать `client.listProjects()`.
3. Найти projects, у которых `path.resolve(project.workspacePath) === workspaceContext.workspacePath` или `project.workspaceFingerprint === workspaceFingerprint`.
4. Если найден ровно один project, сохранить его `bindingId` и продолжить startup.
5. Если найдено больше одного project, завершить startup с ошибкой: MCP не должен сам выбирать между duplicate local bindings. Ошибка должна предложить очистить duplicate registrations вручную.
6. Если project не найден, собрать metadata из Git workspace:
   - `remoteUrl` из `git remote get-url origin` - обязательное поле для авто-регистрации
   - `displayName` из basename root
   - `repoFullName` из remote URL, если распознаётся
   - `defaultBranch` из Git refs/config, если доступно
   - уже вычисленный `workspaceFingerprint` - обязательное поле
   - `preferredActiveBranch` из текущего branch, если доступно
7. Вызвать `client.registerProject(...)` с `idempotencyKey`.
8. Сохранить `result.snapshot.project.bindingId`.
9. Опционально сразу вызвать `client.syncProject({ bindingId, targets: ['code', 'docs'], idempotencyKey })`.

Регистрация происходит только на startup и только для workspace root из project-local config. `code_search` не регистрирует workspace.

Если metadata для регистрации недостаточно, startup должен завершиться понятной ошибкой с командой ручной регистрации.

Metadata helpers нельзя импортировать из `@grepmind/agent`, потому что `@grepmind/mcp` не должен зависеть от полного agent package. Для MVP добавить локальный helper в MCP, повторяющий agent CLI алгоритмы:

- `git -C <workspace> remote get-url origin`
- `git -C <workspace> symbolic-ref --short refs/remotes/origin/HEAD`
- parsing `https://.../owner/repo(.git)`, `ssh://.../owner/repo(.git)` и `git@host:owner/repo(.git)`
- `workspaceFingerprint` через `realpath`, `stat.dev`, `stat.ino`, `sha256`

Если helper понадобится ещё где-то, следующим шагом его можно вынести в `@grepmind/agent-rpc`.

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
const response = await client.searchHead({
  bindingId: workspaceContext.bindingId,
  query: input.query,
  target: input.target ?? 'code',
  limit: searchLimit,
  threshold,
  rerank: true,
  tags,
});

return toSearchResponse(response, {
  path: input.path,
  tags: input.tags,
  limit: requestedLimit,
});
```

LLM не видит путь и не выбирает репозиторий. Agent RPC получает `bindingId` как основной scope; `workspacePath` остаётся в MCP context для startup matching, diagnostics и error messages. Если позже Agent RPC начнёт валидировать одновременную передачу `bindingId` и `workspacePath`, можно передавать оба поля, но текущая реализация резолвит project по `bindingId`.

`path` пока не является частью `SearchHeadRpcParams`, поэтому текущую локальную post-filter логику из `search-client.ts` нужно сохранить: при `path` или `tags` делать overfetch, затем фильтровать результаты локально и обрезать до requested limit. Если в будущем `path` появится в Agent RPC/backend, эту фильтрацию можно перенести ниже.

## Diagnostics Tools

Добавить tool:

```text
grepmind_agent_status
```

Он должен возвращать:

- `workspacePath`
- `bindingId`
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
- workspace не имеет `origin` remote, а project ещё не зарегистрирован
- workspace не удалось зарегистрировать
- найдено несколько local project bindings для одного workspace

Tool errors после успешного startup:

- agent runtime умер после подключения MCP
- search index для текущего workspace ещё не готов
- sync завершился ошибкой

`code_search` не должен возвращать ошибку "выберите workspace" или "зарегистрируйте workspace", если startup прошёл успешно. Ошибка "No local project is registered" после успешного startup считается bug в MCP preparation.

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

Нужно сохранить понятный timeout/error copy: если OAuth не завершился, MCP startup должен завершиться с actionable сообщением, а не зависать без объяснения.

### Project-local cwd зависит от клиента

Некоторые MCP clients могут запускать server не из root проекта даже при project-local config. Поэтому preferred path - явный `--workspace`.

### Multi-root

Один Grepmind MCP instance не поддерживает несколько roots. Это сознательное ограничение, чтобы LLM не выбирал репозиторий и чтобы agent RPC всегда получал один явный `bindingId`.

### Duplicate local bindings

Если `listProjects()` возвращает несколько local bindings с одинаковым `workspacePath`, MCP startup должен падать. Автоматически выбирать первый binding нельзя: это возвращает проблему выбора репозитория обратно в tool layer, только в скрытом виде.

### Path filter

`path` есть в MCP tool schema, но отсутствует в `SearchHeadRpcParams`. Поэтому первая реализация должна сохранить локальный post-filter из `search-client.ts`; прямой вызов `searchHead` из handler без этой логики будет регрессией.

## Рекомендуемый порядок реализации

1. Добавить parsing `--workspace <path>`.
2. Добавить workspace resolver: `--workspace`, иначе `process.cwd()`, затем Git top-level.
3. Добавить `packages/mcp/src/tools/agent-runtime.ts`.
4. Вызвать startup preparation в `packages/mcp/src/index.ts` до `server.connect(transport)`.
5. Добавить MCP-local Git metadata helpers для авто-регистрации.
6. Добавить авто-регистрацию startup workspace и resolve ровно одного `bindingId`.
7. Сохранить `bindingId`, `workspacePath`, `dataDir`, `AgentRuntimeClient` в server-side context.
8. Убрать `workspacePath` из `code_search` schema.
9. Передавать `bindingId` в `searchHead(...)`; `workspacePath` оставить в context для diagnostics/errors.
10. Сохранить текущую overfetch/post-filter обработку `path` и `tags`.
11. Обновить ошибки.
12. Добавить `grepmind_agent_status`.
13. Обновить `packages/mcp/README.md`: project-local config, `--workspace`, startup auth/runtime/register, отсутствие `workspacePath` в tool input.
14. Запустить build для проверки новой версии кода.

## Минимальный MVP

Для первого изменения достаточно:

- `--workspace <path>`
- resolve Git root
- `ensureAgentReady(...)` на startup
- регистрация workspace на startup
- resolve и cache `bindingId`
- `code_search` без `workspacePath`
- server-side подстановка `bindingId`, при сохранении `workspacePath` в context
- сохранение локальной `path`/`tags` post-filter логики
- подключение `StdioServerTransport` только после готовности

Это даёт строгую модель: MCP сам поднимает и логинит агента, workspace фиксируется на startup, а поиск всегда идёт по одному явно определённому репозиторию без участия LLM.

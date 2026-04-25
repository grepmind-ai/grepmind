# План: создание MCP инструментов поиска по коду

## Context

MCP сервер работает локально и подключается к удалённому grepmind-app серверу через HTTP API. Нужно создать 2 MCP-инструмента: семантический поиск и текстовый поиск.

**Search API:** `GET /api/repos/:userRepoId/search`

- Auth: `Authorization: Bearer <api-key>` (Clerk API key пользователя или организации)
- Query params: `q`, `mode` (semantic|text), `limit`, `path`, `threshold`
- Response: `{ results: [{ symbol: { id, name, type, path, relativePath, signature, docstring, startLine, endLine, parentSymbol }, score, content }] }`

**Файл API:** `packages/app/src/routes/repos-routes.ts:503-573`

---

## Phase 0: Серверная часть — API Key авторизация ✅ DONE

Реализовано. Сервер поддерживает авторизацию через Clerk API key (`Authorization: Bearer <api-key>`). Токен определяется по формату: API key vs JWT. Оба пути устанавливают `request.userId` и `request.dbUserId`.

---

## Файлы для создания

### 1. `packages/mcp/src/tools/code_search_vector.ts` — Семантический поиск

Поиск по смыслу через embeddings.

**Schema:**

```typescript
codeSearchVectorSchema = z.object({
  query: z
    .string()
    .describe('Describe what the code does (e.g., "validate user input")'),
  limit: z.number().optional().describe('Max results (default: 10)'),
  threshold: z
    .number()
    .optional()
    .describe('Min similarity 0-1 (default: 0.5)'),
  path: z.string().optional().describe('Filter by path prefix'),
  compact: z
    .boolean()
    .optional()
    .describe('Return only signatures, not full code'),
});
```

**Вызов API:** `GET /api/repos/:repoId/search?q=...&mode=semantic&limit=...&path=...&threshold=...`

**Экспорты:** `codeSearchVectorSchema`, `codeSearchVectorTool`

---

### 2. `packages/mcp/src/tools/code_search_bm25.ts` — Текстовый поиск

Поиск по точным именам символов через текстовый индекс.

**Schema:**

```typescript
codeSearchBm25Schema = z.object({
  query: z
    .string()
    .describe('Exact symbol names (e.g., "handleRequest", "validateUser")'),
  limit: z.number().optional().describe('Max results (default: 10)'),
  path: z.string().optional().describe('Filter by path prefix'),
  compact: z
    .boolean()
    .optional()
    .describe('Return only signatures, not full code'),
});
```

**Вызов API:** `GET /api/repos/:repoId/search?q=...&mode=text&limit=...&path=...`

**Экспорты:** `codeSearchBm25Schema`, `codeSearchBm25Tool`

---

### 3. `packages/mcp/src/tools/search-client.ts` — HTTP клиент

Общий HTTP клиент для обоих инструментов.

```typescript
interface SearchResult {
  symbol: {
    id: string;
    name: string;
    type: string;
    path: string;
    relativePath: string;
    signature: string | null;
    docstring: string | null;
    startLine: number;
    endLine: number;
    parentSymbol: string | null;
  };
  score: number;
  content: string;
}

interface SearchResponse {
  results: SearchResult[];
}

async function searchCode(params: {
  query: string;
  mode: 'semantic' | 'text';
  limit?: number;
  threshold?: number;
  path?: string;
}): Promise<SearchResponse>;
```

Конфигурация из `process.env`:

| Переменная         | Описание                                           |
| ------------------ | -------------------------------------------------- |
| `GREPMIND_API_URL` | Base URL сервера (e.g. `https://app.grepmind.dev`) |
| `GREPMIND_API_KEY` | Clerk API key пользователя или организации         |
| `GREPMIND_REPO_ID` | ID репозитория                                     |

**Auth header:** `Authorization: Bearer <GREPMIND_API_KEY>`

HTTP клиент: нативный `fetch` (Node 18+).

---

## Формат результатов (MCP response)

**Full mode:**

````
## 1. path:startLine-endLine [type] name (score: 0.85)

**Signature:** `function handleRequest(req: Request): Response`

**Docstring:**
Handles incoming HTTP requests

**Parent:** RequestHandler

```typescript
code content here
````

```

**Compact mode:**
```

## 1. name [type] (score: 0.85)

path:startLine
`signature`

```

Разделитель: `\n\n---\n\n`

Метаданные: `_meta: { tokens_approx, truncated, returned_results }`

---

## Референсные файлы

| Файл | Что содержит |
|---|---|
| `packages/app/src/routes/repos-routes.ts:503-573` | Search API endpoint |
| `packages/app/src/plugins/clerk-auth.ts` | Auth middleware (JWT для веба, API key для MCP) |
| `packages/app/src/repositories/user-repository.ts` | `findByClerkId()`, `findOrCreateByClerkId()` |

---

## Верификация

1. `cd packages/mcp && npx tsc --noEmit` — проверка типов
2. Проверить API key авторизацию: `curl -H "Authorization: Bearer <api-key>" <url>/api/repos/:id/search?q=test`
3. Запустить MCP сервер с `GREPMIND_API_KEY` в env, вызвать оба инструмента через MCP inspector
4. Проверить что JWT сессии (веб) и API ключи (MCP) работают каждый по своему пути
```

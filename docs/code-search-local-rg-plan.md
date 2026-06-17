# План реализации локального rg-сигнала в code_search

## Цель

Сделать `code_search` единым инструментом поиска по коду и документации для AI-агентов. Инструмент должен работать в одном продуктовом режиме: пользователь или модель описывает, что нужно найти, а при необходимости добавляет точный текстовый или regex-якорь. Внутри агент может использовать semantic search и локальный `rg`, но наружу это не должно выглядеть как выбор между разными режимами.

Ключевое требование: результаты `rg` не отправляются на backend. Агент запускает `rg` локально, локально объединяет и дедуплицирует результаты, затем возвращает один нормализованный ответ `code_search`.

## Текущая архитектура

Сейчас поток такой:

1. `packages/mcp/src/tools/code_search.ts` регистрирует MCP tool `code_search`.
2. `packages/mcp/src/tools/search-client.ts` вызывает локальный agent runtime через `AgentRuntimeClient.searchHead`.
3. `packages/agent-rpc/src/protocol.ts` описывает RPC payload `SearchHeadRpcParams`.
4. `packages/agent/src/services/search-head-service.ts` резолвит локальный проект, branch, HEAD commit и revision.
5. `SearchHeadService` вызывает `searchTransport.search(...)`, который выполняет текущий semantic поиск.

Ограничения текущей версии:

- MCP schema принимает только `query` как natural language описание.
- `search-client.ts` явно разрешает только semantic path.
- RPC `searchHead` не умеет принимать локальный exact-поиск.
- `SearchResponsePayload` не различает источник результата.
- `rg` в agent search pipeline отсутствует.

## Продуктовая модель

У `code_search` не должно быть параметра `mode`.

Публичная модель инструмента:

```ts
{
  query: string;
  target?: 'code' | 'docs';
  exact?: {
    pattern: string;
    regex?: boolean;
    caseSensitive?: boolean;
  };
  path?: string;
  globs?: string[];
  limit?: number;
  compact?: boolean;
}
```

Семантика:

- `query` всегда описывает намерение поиска.
- `exact.pattern` является дополнительным точным сигналом для локального `rg`.
- Если `exact` не передан, поведение остается близким к текущему semantic `code_search`.
- Если `exact` передан, агент запускает локальный `rg` и использует его результаты при формировании ответа.
- Если доступны semantic и rg-результаты, агент объединяет их локально.
- Backend не получает `exact.pattern`, `globs`, `path` для `rg` и сами совпадения `rg`.

Для AI описание tool должно направлять модель так:

```text
Use query to describe what you need. Add exact.pattern when you know an identifier,
error text, route, config key, import path, function name, or regex that should
appear in relevant files. The tool returns one ranked code/docs result list.
```

## Целевая архитектура

Поток после изменений:

1. MCP `code_search` принимает `query` и optional `exact`.
2. MCP вызывает `searchCode(...)`.
3. `searchCode(...)` передает `exact`, `path`, `globs` в local RPC `searchHead`.
4. `SearchHeadService` резолвит локальный проект и HEAD как сейчас.
5. `SearchHeadService` при необходимости вызывает semantic backend search только с semantic payload.
6. `SearchHeadService` при наличии `exact` вызывает локальный `LocalRgSearchService`.
7. Агент локально нормализует rg matches в search-result candidates.
8. Агент локально dedup/merge semantic candidates и rg candidates.
9. Агент возвращает один `SearchHeadResult` через существующий RPC.

Backend видит только текущий semantic запрос:

```ts
{
  (requestId,
    bindingId,
    revisionId,
    query,
    target,
    limit,
    threshold,
    rerank,
    tags);
}
```

Backend не видит:

- `exact.pattern`
- `regex`
- `caseSensitive`
- `globs`
- локальный working tree context
- список rg matches

## Изменения в контрактах

### agent-rpc

Файл: `packages/agent-rpc/src/protocol.ts`

Добавить типы:

```ts
export interface SearchExactQuery {
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
}

export interface SearchHeadRpcParams {
  bindingId?: number;
  workspacePath?: string;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  tags?: string[];
  exact?: SearchExactQuery;
  path?: string;
  globs?: string[];
  contextLines?: number;
}
```

`query` остается обязательным, чтобы tool не превращался в низкоуровневую оболочку над `rg`. Если позже понадобится чистый exact-поиск без semantic intent, можно разрешить `query` равным короткому описанию вроде `"exact code search"` на стороне MCP, но контракт лучше держать простым.

### backend contracts

Файл: `packages/agent/src/backend/contracts/search.ts`

Backend `SearchRequestPayload` менять не нужно, потому что `rg` не должен уходить на backend.

Можно расширить `SearchResultItem` метаданными источника, но это не обязательно для первой версии. Минимальный вариант: rg-only результаты мапятся в существующую форму:

```ts
{
  chunkId: `rg:${relativePath}:${line}`,
  artifactRef: null,
  branch,
  target,
  path: absolutePath,
  relativePath,
  previewText,
  score,
  symbol: {
    id: `rg:${relativePath}:${line}`,
    name: '',
    type: 'match',
    signature: null,
    docstring: null,
    startLine: line,
    endLine: line,
    parentSymbol: null
  },
  tags: []
}
```

Для лучшей отладки можно добавить optional поле:

```ts
source?: 'semantic' | 'rg' | 'merged';
```

Но это затрагивает нормализацию realtime bridge и RPC. Поэтому для первой версии лучше не менять публичную форму result item, а источник отражать только в `_meta` MCP ответа.

## Изменения в MCP

### Schema

Файл: `packages/mcp/src/tools/code_search.ts`

Расширить `codeSearchSchema`:

```ts
exact: z.object({
  pattern: z.string().min(1),
  regex: z.boolean().optional(),
  caseSensitive: z.boolean().optional(),
}).optional(),
globs: z.array(z.string().min(1)).optional(),
contextLines: z.number().int().min(0).max(10).optional(),
```

`path` оставить как есть, но его нужно передавать в RPC, а не только применять после semantic overfetch. Для `rg` это должен быть локальный path scope.

### Tool description

Текущее описание слишком semantic-only:

```text
Code search - find code by describing what it does in natural language
```

Заменить на:

```text
Code and docs search over the current workspace. Describe intent in query.
Optionally add exact.pattern for identifiers, strings, routes, config keys,
error text, imports, or regex anchors that should appear in relevant files.
```

### search-client

Файл: `packages/mcp/src/tools/search-client.ts`

Убрать concept `mode: 'semantic' | 'text'` из внутреннего API. Вместо этого:

```ts
export async function searchCode(params: {
  query: string;
  target?: 'code' | 'docs';
  limit?: number;
  threshold?: number;
  path?: string;
  tags?: string[];
  exact?: SearchExactQuery;
  globs?: string[];
  contextLines?: number;
}): Promise<SearchResponse>;
```

Передавать новые поля в `client.searchHead(...)`.

Post-filter по `path` можно оставить как защиту, но основной path filtering для `rg` должен происходить в agent.

## Изменения в agent runtime

### Request validation

Файл: `packages/agent/src/runtime/server/request-validation.ts`

Добавить нормализацию:

- `exact.pattern`: non-empty string, разумный max length.
- `exact.regex`: boolean.
- `exact.caseSensitive`: boolean.
- `path`: optional non-empty string.
- `globs`: optional string array, max count.
- `contextLines`: integer 0..10.

Рекомендуемые лимиты:

```ts
const MAX_RG_PATTERN_LENGTH = 500;
const MAX_RG_GLOBS = 20;
const MAX_RG_GLOB_LENGTH = 200;
const DEFAULT_RG_CONTEXT_LINES = 2;
const MAX_RG_CONTEXT_LINES = 10;
```

### SearchHeadCommandInput

Файл: `packages/agent/src/services/search-head-service.ts`

Расширить input:

```ts
export interface SearchHeadCommandInput {
  bindingId?: number;
  workspacePath?: string;
  query: string;
  target?: SearchTarget;
  limit?: number;
  threshold?: number;
  rerank?: boolean;
  tags?: string[];
  exact?: SearchExactQuery;
  path?: string;
  globs?: string[];
  contextLines?: number;
}
```

### LocalRgSearchService

Добавить новый файл:

`packages/agent/src/services/local-rg-search-service.ts`

Ответственность сервиса:

- безопасно запускать `rg` через `execFile`, без shell;
- работать только внутри `project.workspacePath`;
- поддерживать `target`, `path`, `globs`, `regex`, `caseSensitive`, `contextLines`;
- парсить `rg --json`;
- ограничивать runtime, stdout size и число matches;
- возвращать нормализованные локальные candidates.

Пример интерфейса:

```ts
export interface LocalRgSearchInput {
  workspacePath: string;
  branch: string;
  target: SearchTarget | undefined;
  path?: string;
  globs?: string[];
  exact: SearchExactQuery;
  contextLines: number;
  limit: number;
}

export interface LocalRgSearchResult {
  items: LocalRgSearchItem[];
  stats: {
    matchCount: number;
    fileCount: number;
    truncated: boolean;
    durationMs: number;
  };
}
```

Запуск:

```ts
const args = [
  '--json',
  '--line-number',
  '--column',
  '--with-filename',
  '--context',
  String(contextLines),
  '--max-count',
  String(maxCountPerFile),
];

if (!exact.regex) {
  args.push('--fixed-strings');
}

if (!exact.caseSensitive) {
  args.push('--ignore-case');
}

for (const glob of resolvedGlobs) {
  args.push('--glob', glob);
}

args.push(exact.pattern);
args.push(searchRoot);
```

Важно: `execFile('rg', args, { cwd: workspacePath })`, не `exec` и не shell-команда.

### Path safety

`path` должен быть только относительным путем внутри workspace:

- trim;
- удалить leading `/`;
- `path.resolve(workspacePath, path)` должен оставаться внутри `workspacePath`;
- запретить `..` escape;
- если path не существует, вернуть пустой rg result, не падать.

### Target filtering

Для `target: 'docs'` можно ограничить globs:

```text
**/*.md
**/*.mdx
**/*.txt
docs/**
README*
CHANGELOG*
```

Для `target: 'code'` исключить типичные docs-only файлы не обязательно. Лучше оставить rg по workspace/path, потому что кодовые настройки часто лежат в markdown-adjacent или config файлах. Если нужен строгий режим, его стоит добавить позже.

Всегда использовать default excludes `rg` через `.gitignore`. Не добавлять `--hidden` в первой версии.

## Dedup и merge

Добавить локальный helper, например:

`packages/agent/src/services/search-result-merge.ts`

Вход:

```ts
interface MergeSearchResultsInput {
  semanticItems: SearchResultItem[];
  rgItems: SearchResultItem[];
  limit: number;
}
```

Правила dedup:

1. Exact duplicate:
   - одинаковый `relativePath`;
   - одинаковый `symbol.startLine`;
   - одинаковый `symbol.endLine`.
   - оставить один результат.

2. rg внутри semantic symbol range:
   - `rg.relativePath === semantic.relativePath`;
   - `rg.startLine >= semantic.startLine`;
   - `rg.startLine <= semantic.endLine`.
   - вернуть semantic item, но поднять score и добавить rg context в `previewText`, если текущий preview хуже.

3. Близкое попадание:
   - тот же файл;
   - расстояние до semantic range не больше `contextLines + 3`.
   - вернуть semantic item с меньшим boost.

4. rg-only:
   - вернуть как `symbol.type = 'match'`.

5. semantic-only:
   - оставить как есть.

Score:

```ts
const RG_EXACT_SCORE = 0.92;
const RG_REGEX_SCORE = 0.88;
const MERGED_BOOST = 0.12;
const NEARBY_BOOST = 0.06;

merged.score = Math.min(1, semantic.score + MERGED_BOOST);
rgOnly.score = exact.regex ? RG_REGEX_SCORE : RG_EXACT_SCORE;
```

Сортировка:

1. merged semantic+rg;
2. rg exact matches;
3. semantic high-score;
4. rg regex matches;
5. остальные semantic.

Если сортировка через numeric score дает достаточно стабильный порядок, отдельный comparator можно не усложнять.

## Формирование rg preview

`rg --json` возвращает события `match`, `context`, `begin`, `end`.

Для первой версии достаточно:

- собрать context lines вокруг match;
- highlight не делать;
- сохранить исходные line breaks;
- ограничить preview по символам.

Preview format:

```text
42: const schema = z.object({
43:   repoName: z.string().min(1)
44: })
```

Для multiline matches учитывать start line из `submatches[0].start`, но result range можно оставить как одну строку в первой версии.

## Ошибки и fallback

`rg` exit codes:

- `0`: matches found.
- `1`: no matches, это успешный пустой результат.
- `2+`: ошибка запуска или regex parse error.

Поведение:

- Если semantic search успешен, а `rg` упал из-за invalid regex, вернуть semantic результаты и добавить предупреждение в meta.
- Если semantic search не запускался или тоже упал, вернуть ошибку.
- Если `rg` binary отсутствует, вернуть semantic результаты и warning.

Так как продуктовый режим один, ошибка rg не должна ломать обычный semantic `code_search`, кроме случая когда пользователь фактически полагался только на exact-якорь и semantic результата нет.

## Metadata

MCP `_meta` расширить:

```ts
{
  tokens_approx: number;
  truncated: boolean;
  returned_results: number;
  semantic_results?: number;
  rg_results?: number;
  rg_truncated?: boolean;
  rg_source?: 'working_tree';
  rg_warning?: string;
}
```

Важно отражать разницу источников:

- semantic ищет по synced HEAD/revision;
- rg ищет по локальному working tree.

Это полезно для coding agent, потому что он видит незакоммиченные изменения. Но в meta нужно явно указать `rg_source: 'working_tree'`.

## Безопасность и лимиты

Обязательные ограничения:

- не использовать shell;
- не принимать raw rg args от пользователя;
- не разрешать path traversal за пределы workspace;
- timeout на rg, например 10 секунд;
- max stdout bytes, например 5-10 MB;
- max matches, например `limit * 5`, но не больше 200;
- max preview chars на result;
- max globs count и длина glob;
- max pattern length.

Не добавлять в первой версии:

- `--hidden`;
- `--no-ignore`;
- произвольные include/exclude flags;
- поиск вне workspace.

## План работ

### Этап 1. Контракты RPC

1. Добавить `SearchExactQuery` в `packages/agent-rpc/src/protocol.ts`.
2. Расширить `SearchHeadRpcParams` полями `exact`, `path`, `globs`, `contextLines`.
3. Экспортировать новые типы из `packages/agent-rpc/src/index.ts`, если index использует explicit export list.
4. Обновить runtime request validation в `packages/agent/src/runtime/server/request-validation.ts`.

Готовность этапа:

- RPC принимает новый payload;
- старые клиенты продолжают работать;
- backend search payload не изменен.

### Этап 2. MCP schema и client

1. Расширить `codeSearchSchema` в `packages/mcp/src/tools/code_search.ts`.
2. Обновить description tool.
3. Убрать внутренний `mode` из `searchCode(...)`.
4. Передавать `exact`, `path`, `globs`, `contextLines` в `searchHead`.
5. Обновить formatting пустого результата: сообщение не должно говорить только про semantic similarity.

Готовность этапа:

- AI видит один tool без выбора режима;
- exact-параметры доходят до agent runtime.

### Этап 3. LocalRgSearchService

1. Создать `packages/agent/src/services/local-rg-search-service.ts`.
2. Реализовать safe path resolve.
3. Реализовать args builder для `rg --json`.
4. Реализовать запуск через `execFile`.
5. Реализовать parser для json-lines output.
6. Сформировать `SearchResultItem[]` или промежуточные `LocalRgSearchItem[]`.
7. Добавить обработку exit code `1` как empty result.

Готовность этапа:

- сервис локально возвращает matches по workspace;
- invalid regex и отсутствие matches обрабатываются предсказуемо;
- нет shell execution.

### Этап 4. Merge/dedup

1. Создать helper `search-result-merge.ts`.
2. Реализовать exact duplicate dedup.
3. Реализовать merge, когда rg line внутри semantic symbol range.
4. Реализовать score boost.
5. Реализовать final sort и limit.

Готовность этапа:

- один и тот же код не возвращается дважды;
- exact-якорь улучшает порядок результатов;
- semantic-only поведение сохраняется.

### Этап 5. Интеграция в SearchHeadService

1. Инжектить `LocalRgSearchService` в `SearchHeadService` или создавать default instance в constructor.
2. В `searchByLocalHead` после resolve project/head/revision запускать:
   - semantic search как сейчас;
   - rg search при наличии `input.exact`.
3. Не передавать `exact` в `searchTransport.search`.
4. Объединить результаты локально.
5. Вернуть обычный `SearchHeadResult`.

Готовность этапа:

- backend не получает rg данные;
- agent формирует финальный ответ сам;
- output shape совместим с текущим MCP formatter.

### Этап 6. CLI search-head

Файл: `packages/agent/src/cli/command-handlers/status.ts`

Опционально добавить flags:

```text
--exact <pattern>
--regex
--case-sensitive
--path <path>
--glob <glob>
--context-lines <n>
```

Это не обязательно для MCP, но полезно для ручной проверки agent runtime.

Готовность этапа:

- можно руками проверить `grepmind agent search-head --query ... --exact ...`.

### Этап 7. Документация

Обновить:

- `packages/mcp/README.md`;
- `packages/agent/README.md`, если там описан `search-head`;
- возможно root `README.md`, если там есть пример `code_search`.

Пример документации:

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

## Проверка без test/tsc

По проектным правилам не запускать `test` и `tsc` для проверки. Для новой версии кода запускать `build`, если нужна сборочная проверка.

Минимальная ручная проверка после реализации:

1. Запустить build только если нужна проверка новой версии:

```bash
npm run build
```

2. Запустить локальный MCP/agent сценарий вручную.
3. Проверить вызов `code_search` без `exact`: поведение как раньше.
4. Проверить вызов `code_search` с `exact.pattern`: появляются rg-backed результаты.
5. Проверить invalid regex: semantic fallback и warning.
6. Проверить `path`: поиск не выходит за workspace.
7. Проверить docs target на markdown файлах.

## Acceptance criteria

1. `code_search` остается одним инструментом без параметра `mode`.
2. `exact.pattern` доступен AI как дополнительный точный сигнал.
3. `rg` запускается только локально в agent runtime.
4. Backend не получает rg pattern, rg results или working tree context.
5. Агент локально делает dedup и ranking.
6. Ответ остается совместимым с текущим MCP formatter.
7. Старые вызовы `code_search({ query })` работают как раньше.
8. Path traversal невозможен.
9. `rg` timeout/ошибки не ломают semantic fallback.
10. Meta явно отражает `rg_source: 'working_tree'`, если rg использовался.

## Нерешенные вопросы

1. Нужно ли добавлять `source?: 'semantic' | 'rg' | 'merged'` в публичный `SearchResultItem`, или достаточно `_meta`.
2. Должен ли `target: 'code'` исключать markdown/docs, или лучше искать по всему workspace/path.
3. Нужно ли разрешать чистый exact-поиск без meaningful `query`.
4. Какой default `contextLines`: 2 или 3.
5. Нужно ли учитывать untracked files. По умолчанию `rg` их увидит, если они не игнорируются `.gitignore`.

## Рекомендуемый первый инкремент

Сделать минимальный совместимый вариант:

1. MCP schema: добавить `exact`, `globs`, `contextLines`.
2. RPC params: добавить те же поля.
3. Agent: добавить `LocalRgSearchService`.
4. Agent: rg-only results мапить в существующий `SearchResultItem` без изменения публичной формы.
5. Dedup: только same-file и rg-line-inside-semantic-range.
6. Meta: добавить счетчики rg.

После этого можно улучшать ranking, source metadata и CLI flags.

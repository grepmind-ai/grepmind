import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  AgentBackendClient,
  type AgentBackendClientOptions,
} from '../backend/agent-backend-client.js';
import type { AgentDb } from '../db/schema.js';
import {
  AGENT_MIGRATION_FILES,
  AGENT_MIGRATION_JOURNAL,
} from '../generated/agent-migrations.js';
import {
  createAgentRepositories,
  type AgentRepositories,
} from '../repositories/agent-repositories.js';
import { createAgentDatabase } from '../repositories/database.js';
import { LocalPgliteSearchService } from '../services/local-pglite-search-service.js';
import { ProjectRegistryService } from '../services/project-registry-service.js';
import { ProjectSyncService } from '../services/project-sync-service.js';

export interface AgentRuntimeOptions {
  dataDir: string;
  backend: AgentBackendClientOptions;
  bootstrapOnInit?: boolean;
}

export interface AgentRuntime {
  db: AgentDb;
  backend: AgentBackendClient;
  repositories: AgentRepositories;
  projects: ProjectRegistryService;
  sync: ProjectSyncService;
  search: LocalPgliteSearchService;
  bootstrap(): ReturnType<AgentBackendClient['bootstrap']>;
  close(): Promise<void>;
}

const AGENT_DB_DIRNAME = 'db';
const LEGACY_DB_MARKER_FILENAME = 'PG_VERSION';
const EMBEDDED_DRIZZLE_DIRNAME = '__embedded_drizzle_migrations';

export async function createAgentRuntime(
  options: AgentRuntimeOptions,
): Promise<AgentRuntime> {
  const dbDataDir = await resolveAgentDbDataDir(options.dataDir);
  const db = await PGlite.create(dbDataDir, {
    extensions: {
      vector,
    },
  });
  const agentDb = createAgentDatabase(db);
  const migrationsFolder =
    await materializeEmbeddedDrizzleMigrations(dbDataDir);
  await db.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  await migrate(agentDb, { migrationsFolder });

  const backend = new AgentBackendClient(options.backend);
  const bootstrap =
    options.bootstrapOnInit === false ? null : await backend.bootstrap();
  const repositories = createAgentRepositories(agentDb);
  const projects = new ProjectRegistryService(agentDb, repositories, backend);
  const sync = new ProjectSyncService(
    db,
    backend,
    projects,
    bootstrap?.limits.maxArtifactRefsPerBatch ?? 64,
  );
  const search = new LocalPgliteSearchService({ db });

  return {
    db,
    backend,
    repositories,
    projects,
    sync,
    search,
    bootstrap: () => backend.bootstrap(),
    close: () => db.close(),
  };
}

async function resolveAgentDbDataDir(dataDir: string): Promise<string> {
  const legacyDbMarkerPath = path.join(dataDir, LEGACY_DB_MARKER_FILENAME);
  try {
    await access(legacyDbMarkerPath);
    return dataDir;
  } catch {
    return path.join(dataDir, AGENT_DB_DIRNAME);
  }
}

async function materializeEmbeddedDrizzleMigrations(
  dbDataDir: string,
): Promise<string> {
  const migrationsDir = path.join(dbDataDir, EMBEDDED_DRIZZLE_DIRNAME);
  const metaDir = path.join(migrationsDir, 'meta');

  await mkdir(metaDir, { recursive: true });
  await writeFile(
    path.join(metaDir, '_journal.json'),
    `${JSON.stringify(AGENT_MIGRATION_JOURNAL, null, 2)}\n`,
    'utf8',
  );

  await Promise.all(
    Object.entries(AGENT_MIGRATION_FILES).map(([tag, sql]) =>
      writeFile(path.join(migrationsDir, `${tag}.sql`), sql, 'utf8'),
    ),
  );

  return migrationsDir;
}

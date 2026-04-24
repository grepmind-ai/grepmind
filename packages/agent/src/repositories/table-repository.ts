import { eq } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import type { AgentDatabase, AgentDatabaseExecutor } from './database.js';

export abstract class AgentTableRepository<TTable extends AnyPgTable> {
  protected constructor(
    protected readonly db: AgentDatabase,
    readonly table: TTable,
  ) {}

  protected getExecutor(executor?: AgentDatabaseExecutor): AgentDatabaseExecutor {
    return executor ?? this.db;
  }

  select(executor?: AgentDatabaseExecutor) {
    return this.getExecutor(executor).select().from(this.table);
  }

  insert(
    values: TTable['$inferInsert'] | Array<TTable['$inferInsert']>,
    executor?: AgentDatabaseExecutor,
  ) {
    const normalized = Array.isArray(values) ? values : [values];
    return this.getExecutor(executor).insert(this.table).values(normalized as TTable['$inferInsert'][]);
  }

  update(values: Partial<TTable['$inferInsert']>, executor?: AgentDatabaseExecutor) {
    return this.getExecutor(executor).update(this.table).set(values as Record<string, unknown>);
  }

  delete(executor?: AgentDatabaseExecutor) {
    return this.getExecutor(executor).delete(this.table);
  }
}

type BindingScopedTable = AnyPgTable & {
  bindingId: AnyPgColumn;
};

export abstract class AgentBindingTableRepository<
  TTable extends BindingScopedTable,
> extends AgentTableRepository<TTable> {
  deleteByBindingId(bindingId: number, executor?: AgentDatabaseExecutor) {
    return this.delete(executor).where(eq(this.table.bindingId, bindingId));
  }
}

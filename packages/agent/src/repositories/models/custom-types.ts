import { customType } from 'drizzle-orm/pg-core';

/**
 * PGlite stores vectors as pgvector text literals. The local agent schema does
 * not pin dimensions at the column level, so drizzle's built-in vector(N)
 * column cannot model the existing tables safely.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector';
  },
  toDriver(value: number[]) {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string) {
    const normalized = value.trim();
    if (normalized === '[]') {
      return [];
    }

    return normalized
      .slice(1, -1)
      .split(',')
      .map((entry) => Number.parseFloat(entry));
  },
});

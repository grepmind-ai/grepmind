import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: ['./src/repositories/models/*.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://grepmind:grepmind@localhost:5432/grepmind',
  },
});

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` needs no database; migrate commands require DATABASE_URL.
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/prisma_generate_only' },
});
